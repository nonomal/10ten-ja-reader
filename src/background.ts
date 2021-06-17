/*

  Rikaichamp
  by Brian Birtles
  https://github.com/birtles/rikaichamp

  ---

  Originally based on Rikaikun
  by Erek Speed
  http://code.google.com/p/rikaikun/

  ---

  Originally based on Rikaichan 1.07
  by Jonathan Zarate
  http://www.polarcloud.com/

  ---

  Originally based on RikaiXUL 0.4 by Todd Rudick
  http://www.rikai.com/
  http://rikaixul.mozdev.org/

  ---

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program. If not, see <https://www.gnu.org/licenses/>.

  ---

  Please do not change or remove any of the copyrights or links to web pages
  when modifying any of the files. - Jon

*/

import '../manifest.json.src';

import Bugsnag from '@bugsnag/browser';
import { AbortError, DataSeriesState } from '@birchill/hikibiki-data';
import Browser, { browser } from 'webextension-polyfill-ts';

import {
  DictType,
  isBackgroundRequest,
  SearchRequest,
} from './background-request';
import { updateBrowserAction } from './browser-action';
import { startBugsnag } from './bugsnag';
import { Config } from './config';
import { ContentConfig } from './content-config';
import {
  notifyDbStateUpdated,
  DbListenerMessage,
} from './db-listener-messages';
import { ExtensionStorageError } from './extension-storage-error';
import {
  JpdictStateWithFallback,
  cancelUpdateDb,
  deleteDb,
  initDb,
  updateDb,
  searchKanji,
  searchNames,
  searchWords,
  translate,
} from './jpdict';
import { shouldRequestPersistentStorage } from './quota-management';
import {
  NameResult,
  RawSearchResult,
  SearchResult,
  WordSearchResult,
} from './search-result';

//
// Setup bugsnag
//

startBugsnag();

//
// Setup config
//

const config = new Config();

config.addChangeListener((changes) => {
  // Add / remove context menu as needed
  if (changes.hasOwnProperty('contextMenuEnable')) {
    if ((changes as any).contextMenuEnable.newValue) {
      addContextMenu();
    } else {
      removeContextMenu();
    }
  }

  // Update pop-up style as needed
  if (enabled && changes.hasOwnProperty('popupStyle')) {
    const popupStyle = (changes as any).popupStyle.newValue;
    updateBrowserAction({
      popupStyle,
      enabled: true,
      jpdictState,
    });
  }

  // Update toggle key
  if (
    changes.hasOwnProperty('toggleKey') &&
    browser.commands &&
    typeof (browser.commands as any).update === 'function'
  ) {
    try {
      (browser.commands as any).update({
        name: '_execute_browser_action',
        shortcut: (changes as any).toggleKey.newValue,
      });
    } catch (e) {
      const message = `Failed to update toggle key to ${
        (changes as any).toggleKey.newValue
      }`;
      console.error(message);
      Bugsnag.notify(message, (event) => {
        event.severity = 'warning';
      });
    }
  }

  // Update dictionary language
  if (changes.hasOwnProperty('dictLang')) {
    const newLang = (changes as any).dictLang.newValue;
    Bugsnag.leaveBreadcrumb(`Changing language of database to ${newLang}.`);
    updateDb({ lang: newLang, force: true });
  }

  // Tell the content scripts about any changes
  //
  // TODO: Ignore changes that aren't part of contentConfig
  updateConfig(config.contentConfig);
});

async function updateConfig(config: ContentConfig) {
  if (!enabled) {
    return;
  }

  const windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ['normal'],
  });

  for (const win of windows) {
    console.assert(typeof win.tabs !== 'undefined');
    for (const tab of win.tabs!) {
      console.assert(
        typeof tab.id === 'number',
        `Unexpected tab id: ${tab.id}`
      );
      browser.tabs
        .sendMessage(tab.id!, { type: 'enable', config })
        .catch(() => {
          /* Some tabs don't have the content script so just ignore
           * connection failures here. */
        });
    }
  }
}

config.ready.then(() => {
  if (config.contextMenuEnable) {
    addContextMenu();
  }

  // I'm not sure if this can actually happen, but just in case, update the
  // toggleKey command if it differs from what is currently set.
  if (
    browser.commands &&
    typeof (browser.commands as any).update === 'function'
  ) {
    const getToggleCommand =
      async (): Promise<Browser.Commands.Command | null> => {
        const commands = await browser.commands.getAll();
        for (const command of commands) {
          if (command.name === '_execute_browser_action') {
            return command;
          }
        }
        return null;
      };

    getToggleCommand().then((command: Browser.Commands.Command | null) => {
      if (command && command.shortcut !== config.toggleKey) {
        try {
          (browser.commands as any).update({
            name: '_execute_browser_action',
            shortcut: config.toggleKey,
          });
        } catch (e) {
          const message = `On startup, failed to update toggle key to ${config.toggleKey}`;
          console.error(message);
          Bugsnag.notify(message, (event) => {
            event.severity = 'warning';
          });
        }
      }
    });
  }
});

//
// Jpdict database
//

let jpdictState: JpdictStateWithFallback = {
  words: {
    state: DataSeriesState.Initializing,
    version: null,
    fallbackState: 'unloaded',
  },
  kanji: {
    state: DataSeriesState.Initializing,
    version: null,
  },
  radicals: {
    state: DataSeriesState.Initializing,
    version: null,
  },
  names: {
    state: DataSeriesState.Initializing,
    version: null,
  },
  updateState: { state: 'idle', lastCheck: null },
};

async function initJpDict() {
  await config.ready;
  initDb({ lang: config.dictLang, onUpdate: onDbStatusUpdated });
}

function onDbStatusUpdated(state: JpdictStateWithFallback) {
  jpdictState = state;

  updateBrowserAction({
    popupStyle: config.popupStyle,
    enabled,
    jpdictState: state,
  });

  notifyDbListeners();
}

//
// Listeners
//

const dbListeners: Array<Browser.Runtime.Port> = [];

function isDbListenerMessage(evt: unknown): evt is DbListenerMessage {
  return typeof evt === 'object' && typeof (evt as any).type === 'string';
}

browser.runtime.onConnect.addListener((port: Browser.Runtime.Port) => {
  dbListeners.push(port);

  // Push initial state to new listener
  notifyDbListeners(port);

  port.onMessage.addListener(async (evt: unknown) => {
    if (!isDbListenerMessage(evt)) {
      return;
    }

    switch (evt.type) {
      case 'updatedb':
        await config.ready;

        Bugsnag.leaveBreadcrumb('Manually triggering database update');
        updateDb({ lang: config.dictLang, force: true });
        break;

      case 'cancelupdatedb':
        Bugsnag.leaveBreadcrumb('Manually canceling database update');
        cancelUpdateDb();
        break;

      case 'deletedb':
        Bugsnag.leaveBreadcrumb('Manually deleting database');
        deleteDb();
        break;

      case 'reporterror':
        Bugsnag.notify(evt.message);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    const index = dbListeners.indexOf(port);
    if (index !== -1) {
      dbListeners.splice(index, 1);
    }
  });
});

async function notifyDbListeners(specifiedListener?: Browser.Runtime.Port) {
  if (!dbListeners.length) {
    return;
  }

  const message = notifyDbStateUpdated(jpdictState);

  for (const listener of dbListeners) {
    if (specifiedListener && listener !== specifiedListener) {
      continue;
    }

    try {
      listener.postMessage(message);
    } catch (e) {
      console.log('Error posting message');
      console.log(e);
      Bugsnag.notify(e || '(Error posting message update message)');
    }
  }
}

//
// Context menu
//

function addContextMenu() {
  const contexts: Array<Browser.Menus.ContextType> = [
    'browser_action',
    'editable',
    'frame',
    'image',
    'link',
    'page',
    'selection',
    'tab',
    'video',
  ];

  try {
    // We'd like to use:
    //
    //   command: '_execute_browser_action'
    //
    // here instead of onclick but:
    //
    // a) Chrome etc. don't support that
    // b) Firefox passes the wrong tab ID to the callback when the command is
    //    activated from the context menu of a non-active tab.
    browser.contextMenus.create({
      id: 'context-toggle',
      type: 'checkbox',
      title: browser.i18n.getMessage('menu_enable_extension'),
      onclick: (_info, tab) => toggle(tab),
      contexts,
      checked: enabled,
    });
  } catch (_e) {
    // Give up. We're probably on a platform that doesn't support the
    // contextMenus API such as Firefox for Android.
  }
}

async function removeContextMenu() {
  try {
    await browser.contextMenus.remove('context-toggle');
  } catch (e) {
    // Ignore
  }
}

//
// Tab toggling
//

let enabled: boolean = false;

async function enableTab(tab: Browser.Tabs.Tab) {
  console.assert(typeof tab.id === 'number', `Unexpected tab ID: ${tab.id}`);

  updateBrowserAction({
    popupStyle: config.popupStyle,
    enabled: true,
    jpdictState,
  });

  try {
    await config.ready;
  } catch (e) {
    Bugsnag.notify(e || '(No error)');
    return;
  }

  if (config.contextMenuEnable) {
    browser.contextMenus
      .update('context-toggle', { checked: true })
      .catch(() => {
        // Ignore
      });
  }

  try {
    Bugsnag.leaveBreadcrumb('Triggering database update from enableTab...');
    initJpDict();

    // Send message to current tab to add listeners and create stuff
    browser.tabs
      .sendMessage(tab.id!, {
        type: 'enable',
        config: config.contentConfig,
      })
      .catch(() => {
        /* Some tabs don't have the content script so just ignore
         * connection failures here. */
      });
    enabled = true;
    browser.storage.local.set({ enabled: true }).catch(() => {
      Bugsnag.notify(
        new ExtensionStorageError({ key: 'enabled', action: 'set' }),
        (event) => {
          event.severity = 'warning';
        }
      );
    });

    updateBrowserAction({
      popupStyle: config.popupStyle,
      enabled: true,
      jpdictState,
    });
  } catch (e) {
    Bugsnag.notify(e || '(No error)');

    updateBrowserAction({
      popupStyle: config.popupStyle,
      enabled: true,
      jpdictState,
    });

    if (config.contextMenuEnable) {
      browser.contextMenus
        .update('context-toggle', { checked: false })
        .catch(() => {
          // Ignore
        });
    }
  }
}

async function disableAll() {
  enabled = false;

  browser.storage.local.remove('enabled').catch(() => {
    /* Ignore */
  });

  browser.browserAction.setTitle({
    title: browser.i18n.getMessage('command_toggle_disabled'),
  });

  updateBrowserAction({
    popupStyle: config.popupStyle,
    enabled,
    jpdictState,
  });

  if (config.contextMenuEnable) {
    browser.contextMenus
      .update('context-toggle', { checked: false })
      .catch(() => {
        // Ignore
      });
  }

  const windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ['normal'],
  });
  for (const win of windows) {
    console.assert(typeof win.tabs !== 'undefined');
    for (const tab of win.tabs!) {
      console.assert(
        typeof tab.id === 'number',
        `Unexpected tab id: ${tab.id}`
      );
      browser.tabs.sendMessage(tab.id!, { type: 'disable' }).catch(() => {
        /* Some tabs don't have the content script so just ignore
         * connection failures here. */
      });
    }
  }
}

function toggle(tab: Browser.Tabs.Tab) {
  if (enabled) {
    disableAll();
  } else {
    Bugsnag.leaveBreadcrumb('Enabling tab from toggle');
    enableTab(tab);
  }
}

//
// Search
//

// The order in which we cycle/search through dictionaries.
const defaultOrder: Array<DictType> = ['words', 'kanji', 'names'];

// In some cases, however, where we don't find a match in the word dictionary
// but find a good match in the name dictionary, we want to show that before
// kanji entries so we use a different order.
const preferNamesOrder: Array<DictType> = ['names', 'kanji'];

async function search({
  input,
  prevDict,
  preferNames,
  includeRomaji,
  abortSignal,
}: SearchRequest & { abortSignal: AbortSignal }): Promise<SearchResult | null> {
  // Work out which dictionary to use
  let cycleOrder = preferNames ? preferNamesOrder : defaultOrder;
  let dict = prevDict
    ? cycleOrder[(cycleOrder.indexOf(prevDict) + 1) % cycleOrder.length]
    : 'words';

  // Set up a helper for checking for a better names match
  const hasGoodNameMatch = async () => {
    const nameMatch = await searchNames({ input });
    // We could further refine this condition by checking that:
    //
    //   !isHiragana(text.substring(0, nameMatch.matchLen))
    //
    // However, we only call this when we have no match in the words dictionary,
    // meaning we only have the name and kanji dictionaries left. The kanji
    // dictionary presumably is not going to match on an all-hiragana key anyway
    // so it's probably fine to prefer the name dictionary even if it's an
    // all-hiragana match.
    return nameMatch && nameMatch.matchLen > 1;
  };

  const originalDict = dict;
  do {
    if (abortSignal.aborted) {
      throw new AbortError();
    }

    let result: RawSearchResult | null = null;
    switch (dict) {
      case 'words':
        result = await wordSearch({ input, includeRomaji, abortSignal });
        break;

      case 'kanji':
        result = await searchKanji([...input][0]);
        break;

      case 'names':
        result = await searchNames({ input });
        break;
    }

    if (result) {
      return { ...result, preferNames: !!preferNames };
    }

    // Check the abort status again here since it might let us avoid doing a
    // lookup of the names dictionary.
    if (abortSignal.aborted) {
      throw new AbortError();
    }

    // If we just looked up the default words dictionary and didn't find a
    // match, consider if we should switch to prioritizing the names dictionary.
    if (
      !prevDict &&
      !preferNames &&
      dict === 'words' &&
      (await hasGoodNameMatch())
    ) {
      preferNames = true;
      dict = preferNamesOrder[0];
      // (We've potentially created an infinite loop here since we've switched
      // to a cycle order that excludes the word dictionary which may be the
      // originalDict -- hence the loop termination condition will never be
      // true. However, we know that we have a names match so we should always
      // end up returning something.)
    } else {
      // Otherwise just try the next dictionary.
      cycleOrder = preferNames ? preferNamesOrder : defaultOrder;
      dict = cycleOrder[(cycleOrder.indexOf(dict) + 1) % cycleOrder.length];
    }
  } while (originalDict !== dict);

  return null;
}

async function wordSearch(params: {
  input: string;
  max?: number;
  includeRomaji?: boolean;
  abortSignal: AbortSignal;
}): Promise<WordSearchResult | null> {
  const result = await searchWords(params);

  // The name search we (sometimes) do below can end up adding an extra 30% or
  // more to the total lookup time so we should check we haven't been aborted
  // before going on.
  if (params.abortSignal.aborted) {
    throw new AbortError();
  }

  // Check for a longer match in the names dictionary, but only if the existing
  // match has some non-hiragana characters in it.
  //
  // The names dictionary contains mostly entries with at least some kanji or
  // katakana but it also contains entries that are solely hiragana (e.g.
  // はなこ without any corresponding kanji). Generally we only want to show
  // a name preview if it matches on some kanji or katakana as otherwise it's
  // likely to be a false positive.
  //
  // While it might seem like it would be enough to check if the existing
  // match from the words dictionary is hiragana-only, we can get cases where
  // a longer match in the names dictionary _starts_ with hiragana but has
  // kanji/katakana later, e.g. ほとけ沢.
  if (result) {
    const nameResult = await searchNames({
      input: params.input,
      minLength: result.matchLen + 1,
    });
    if (nameResult) {
      const names: Array<NameResult> = [];

      // Add up to three results provided they have a kanji reading and are all
      // are as long as the longest match.
      for (const [i, name] of nameResult.data.entries()) {
        if (name.k && name.matchLen < nameResult.matchLen) {
          break;
        }

        if (i > 2) {
          result.moreNames = true;
          break;
        }

        names.push(name);
      }

      result.names = names;
      result.matchLen = nameResult.matchLen;
    }
  }

  return result;
}

//
// Browser event handlers
//

browser.tabs.onActivated.addListener((activeInfo) => {
  onTabSelect(activeInfo.tabId);
});

browser.browserAction.onClicked.addListener(toggle);

// We can sometimes find ourselves in a situation where we have a backlog of
// search requests. To avoid that, we simply cancel any previous request.
let pendingSearchRequest: AbortController | undefined;

browser.runtime.onMessage.addListener(
  (
    request: object,
    sender: Browser.Runtime.MessageSender
  ): void | Promise<any> => {
    if (!isBackgroundRequest(request)) {
      console.warn(`Unrecognized request: ${JSON.stringify(request)}`);
      Bugsnag.notify(
        `Unrecognized request: ${JSON.stringify(request)}`,
        (event) => {
          event.severity = 'warning';
        }
      );
      return;
    }

    switch (request.type) {
      case 'enable?':
        if (sender.tab && typeof sender.tab.id === 'number') {
          onTabSelect(sender.tab.id);
        }
        break;

      case 'search':
        if (pendingSearchRequest) {
          pendingSearchRequest.abort();
          pendingSearchRequest = undefined;
        }

        pendingSearchRequest = new AbortController();

        return search({ ...request, abortSignal: pendingSearchRequest.signal })
          .then((result) => {
            pendingSearchRequest = undefined;
            return result;
          })
          .catch((e) => {
            if (e.name !== 'AbortError') {
              Bugsnag.notify(e);
            }
            return null;
          });

      case 'translate':
        return translate({
          text: request.title,
          includeRomaji: request.includeRomaji,
        });

      case 'toggleDefinition':
        config.toggleReadingOnly();
        break;

      case 'reportWarning':
        console.assert(
          typeof request.message === 'string',
          '`message` should be a string'
        );
        Bugsnag.notify(request.message, (event) => {
          event.severity = 'warning';
        });
        break;
    }
  }
);

function onTabSelect(tabId: number) {
  if (!enabled) {
    return;
  }

  config.ready.then(() => {
    browser.tabs
      .sendMessage(tabId, {
        type: 'enable',
        config: config.contentConfig,
      })
      .catch(() => {
        /* Some tabs don't have the content script so just ignore
         * connection failures here. */
      });
  });
}

browser.runtime.onInstalled.addListener(async () => {
  // Request persistent storage permission
  if (navigator.storage) {
    let persisted = await navigator.storage.persisted();
    if (!persisted && (await shouldRequestPersistentStorage())) {
      persisted = await navigator.storage.persist();
      if (persisted) {
        Bugsnag.leaveBreadcrumb('Got persistent storage permission');
      } else {
        Bugsnag.leaveBreadcrumb('Failed to get persistent storage permission');
      }
    }
  }

  Bugsnag.leaveBreadcrumb('Running initJpDict from onInstalled...');
  initJpDict();
});

browser.runtime.onStartup.addListener(() => {
  Bugsnag.leaveBreadcrumb('Running initJpDict from onStartup...');
  initJpDict();
});

// See if we were enabled on the last run
//
// We don't do this in onStartup because that won't run when the add-on is
// reloaded and we want to re-enable ourselves in that case too.
(async function () {
  let getEnabledResult;
  try {
    getEnabledResult = await browser.storage.local.get('enabled');
  } catch (e) {
    // If extension storage fails. Just ignore.
    Bugsnag.notify(
      new ExtensionStorageError({ key: 'enabled', action: 'get' }),
      (event) => {
        event.severity = 'warning';
      }
    );
    return;
  }
  const wasEnabled =
    getEnabledResult &&
    getEnabledResult.hasOwnProperty('enabled') &&
    getEnabledResult.enabled;

  if (!wasEnabled) {
    return;
  }

  // browser.tabs.query sometimes fails with a generic Error with message "An
  // unexpected error occurred". I don't know why. Maybe it should fail? Maybe
  // it's a timing thing? Who knows �‍♂️
  //
  // For now, we just do a single retry, two seconds later. If that fails,
  // I suppose the user will just have to manually re-enable the add-on.
  const tryToEnable = async () => {
    const tabs = await browser.tabs.query({
      currentWindow: true,
      active: true,
    });

    if (tabs && tabs.length) {
      Bugsnag.leaveBreadcrumb(
        'Loading because we were enabled on the previous run'
      );
      enableTab(tabs[0]);
    }
  };

  try {
    await tryToEnable();
  } catch (e) {
    console.log('Failed to re-enable. Will retry in two seconds.');
    setTimeout(() => {
      tryToEnable().catch((e) => {
        console.log('Second attempt to re-enable failed. Giving up.');
      });
    }, 2000);
  }
})();