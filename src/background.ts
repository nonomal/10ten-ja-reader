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

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program; if not, write to the Free Software
  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA

  ---

  Please do not change or remove any of the copyrights or links to web pages
  when modifying any of the files. - Jon

*/

import '../manifest.json.src';
import '../html/background.html.src';

import bugsnag from '@bugsnag/js';
import {
  DatabaseState,
  KanjiDatabase,
  KanjiResult,
} from '@birchill/hikibiki-data';

import { updateBrowserAction, FlatFileDictState } from './browser-action';
import { Config } from './config';
import { Dictionary } from './data';
import {
  notifyDbStateUpdated,
  DbListenerMessage,
  ResolvedDbVersions,
} from './db-listener-messages';

//
// Minimum amount of time to wait before checking for database updates.
//

const UPDATE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours

//
// Setup bugsnag
//

const bugsnagClient = bugsnag({
  apiKey: 'e707c9ae84265d122b019103641e6462',
  autoBreadcrumbs: false,
  autoCaptureSessions: false,
  collectUserIp: false,
  consoleBreadcrumbsEnabled: true,
  logger: null,
});

browser.management.getSelf().then(info => {
  let rikaiVersion = info.version;
  // version_name is a Chrome-only thing but Chrome doesn't allow alpha
  // characters in the version number (Firefox does) so we stick the "alpha"
  // "beta" designation in the name.
  if ((info as any).versionName) {
    rikaiVersion = (info as any).versionName;
  }

  // bugsnag-ts typings don't seem to help here
  (bugsnagClient.app as any).version = rikaiVersion;
  if (info.installType === 'development') {
    (bugsnagClient.app as any).releaseStage = 'development';
  }
});

//
// Setup config
//

const config = new Config();

config.addChangeListener(changes => {
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
      flatFileDictState,
      kanjiDb,
    });
  }

  // Update toggle key
  if (
    changes.hasOwnProperty('toggleKey') &&
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
      bugsnagClient.notify(message, { severity: 'warning' });
    }
  }

  // Update dictionary language
  if (changes.hasOwnProperty('dictLang')) {
    const newLang = (changes as any).dictLang.newValue;
    bugsnagClient.leaveBreadcrumb(
      `Changing language of kanji database to ${newLang}.`
    );

    kanjiDb.setPreferredLang(newLang).then(() => {
      bugsnagClient.leaveBreadcrumb(
        `Changed language of kanji database to ${newLang}. Running initial update...`
      );
      return updateKanjiDb();
    });
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
  if (typeof (browser.commands as any).update === 'function') {
    const getToggleCommand = async (): Promise<browser.commands.Command | null> => {
      const commands = await browser.commands.getAll();
      for (const command of commands) {
        if (command.name === '_execute_browser_action') {
          return command;
        }
      }
      return null;
    };

    getToggleCommand().then((command: browser.commands.Command | null) => {
      if (command && command.shortcut !== config.toggleKey) {
        try {
          (browser.commands as any).update({
            name: '_execute_browser_action',
            shortcut: config.toggleKey,
          });
        } catch (e) {
          const message = `On startup, failed to update toggle key to ${config.toggleKey}`;
          console.error(message);
          bugsnagClient.notify(message, { severity: 'warning' });
        }
      }
    });
  }
});

//
// Kanji database
//

let kanjiDb = initKanjiDb();

function initKanjiDb(): KanjiDatabase {
  const result = new KanjiDatabase();
  let wasDbInError: boolean = false;
  let wasUpdateInError: boolean = false;

  result.onChange = () => {
    // Report any new errors

    if (!wasDbInError && result.state === DatabaseState.Unavailable) {
      bugsnagClient.notify('Database unavailable', {
        severity: 'info',
      });
    }
    wasDbInError = result.state === DatabaseState.Unavailable;

    if (!wasUpdateInError && result.updateState.state === 'error') {
      if (
        result.updateState.error?.name === 'DownloadError' &&
        result.updateState.retryIntervalMs
      ) {
        bugsnagClient.leaveBreadcrumb(
          `Download error: ${result.updateState.error.message}.` +
            ` Retrying in ${result.updateState.retryIntervalMs}ms.`
        );
      } else {
        const { name, message } = result.updateState.error;
        bugsnagClient.notify(`${name}: ${message}`, {
          severity: 'error',
        });
      }
    }
    wasUpdateInError = result.updateState.state === 'error';

    updateBrowserAction({
      popupStyle: config.popupStyle,
      enabled,
      flatFileDictState,
      kanjiDb: result,
    });

    notifyDbListeners();
  };

  result.onWarning = (message: string) => {
    bugsnagClient.notify(message, { severity: 'warning' });
  };

  return result;
}

const dbListeners: Array<browser.runtime.Port> = [];

async function notifyDbListeners(specifiedListener?: browser.runtime.Port) {
  if (!dbListeners.length) {
    return;
  }

  if (
    typeof kanjiDb.dbVersions.kanjidb === 'undefined' ||
    typeof kanjiDb.dbVersions.bushudb === 'undefined'
  ) {
    return;
  }

  const message = notifyDbStateUpdated({
    databaseState: kanjiDb.state,
    updateState: kanjiDb.updateState,
    versions: kanjiDb.dbVersions as ResolvedDbVersions,
  });

  // The lastCheck field in the updateState we get back from the database will
  // only be set if we did a check this session. It is _not_ a stored value.
  // So, if it is not set, use the value we store instead.
  if (message.updateState.lastCheck === null) {
    const getResult = await browser.storage.local.get('lastUpdateKanjiDb');
    if (typeof getResult.lastUpdateKanjiDb === 'number') {
      message.updateState.lastCheck = new Date(getResult.lastUpdateKanjiDb);
    }
  }

  for (const listener of dbListeners) {
    if (specifiedListener && listener !== specifiedListener) {
      continue;
    }

    try {
      listener.postMessage(message);
    } catch (e) {
      console.log('Error posting message');
      console.log(e);
      bugsnagClient.notify(e || '(Error posting message update message)', {
        severity: 'error',
      });
    }
  }
}

async function maybeDownloadData() {
  try {
    await kanjiDb.ready;
  } catch (e) {
    console.error(e);
    bugsnagClient.notify(e || '(Error initializing database)', {
      severity: 'error',
    });
    return;
  }

  if (kanjiDb.state === DatabaseState.Unavailable) {
    return;
  }

  // Set initial language
  await config.ready;
  try {
    bugsnagClient.leaveBreadcrumb(
      `Setting initial language of kanji database to ${config.dictLang}.`
    );
    await kanjiDb.setPreferredLang(config.dictLang);
    bugsnagClient.leaveBreadcrumb(
      `Successfully set language to ${config.dictLang}.`
    );
  } catch (e) {
    console.error(e);
    bugsnagClient.notify(e, { severity: 'error' });
  }

  // Even if the database is not empty, check if it needs an update.
  if (kanjiDb.state === DatabaseState.Ok) {
    let lastUpdateKanjiDb: number | null = null;
    try {
      const getResult = await browser.storage.local.get('lastUpdateKanjiDb');
      lastUpdateKanjiDb =
        typeof getResult.lastUpdateKanjiDb === 'number'
          ? getResult.lastUpdateKanjiDb
          : null;
    } catch (e) {
      // Ignore
    }
    bugsnagClient.leaveBreadcrumb(
      `Got last update time of ${lastUpdateKanjiDb}`
    );

    // If we updated within the minimum window then we're done.
    if (
      lastUpdateKanjiDb &&
      Date.now() - lastUpdateKanjiDb < UPDATE_THRESHOLD_MS
    ) {
      bugsnagClient.leaveBreadcrumb('Downloaded data is up-to-date');
      return;
    }
  }

  updateKanjiDb();
}

async function updateKanjiDb() {
  await kanjiDb.ready;

  if (kanjiDb.state === DatabaseState.Unavailable) {
    return;
  }

  try {
    bugsnagClient.leaveBreadcrumb('Updating kanji database...');
    await kanjiDb.update();
    await browser.storage.local.set({
      lastUpdateKanjiDb: new Date().getTime(),
    });
    bugsnagClient.leaveBreadcrumb('Successfully updated kanji database');
  } catch (e) {
    if (e?.name === 'DownloadError') {
      // Ignore download errors since we will automatically retry these.
      return;
    }

    console.log(e);
    bugsnagClient.notify(e || '(Error updating kanji database)', {
      severity: 'error',
    });
  }
}

browser.runtime.onConnect.addListener((port: browser.runtime.Port) => {
  dbListeners.push(port);
  notifyDbListeners(port);

  port.onMessage.addListener((evt: unknown) => {
    if (!isDbListenerMessage(evt)) {
      return;
    }

    switch (evt.type) {
      case 'updatedb':
        if (kanjiDb.state === DatabaseState.Unavailable) {
          kanjiDb.destroy().then(() => {
            kanjiDb = initKanjiDb();
            maybeDownloadData();
          });
        } else {
          updateKanjiDb();
        }
        break;

      case 'cancelupdatedb':
        bugsnagClient.leaveBreadcrumb('Manually canceling database update');
        kanjiDb.cancelUpdate();
        break;

      case 'deletedb':
        bugsnagClient.leaveBreadcrumb('Manually deleting database');
        kanjiDb.destroy();
        break;

      case 'reporterror':
        bugsnagClient.notify(evt.message);
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

function isDbListenerMessage(evt: unknown): evt is DbListenerMessage {
  return typeof evt === 'object' && typeof (evt as any).type === 'string';
}

//
// Flat-file (legacy) dictionary
//

let flatFileDict: Dictionary | undefined = undefined;
// TODO: This is temporary until we move the other databases to IDB
let flatFileDictState = FlatFileDictState.Ok;

async function loadDictionary(): Promise<void> {
  if (!flatFileDict) {
    flatFileDict = new Dictionary({ bugsnag: bugsnagClient });
  }

  try {
    flatFileDictState = FlatFileDictState.Loading;
    await flatFileDict.loaded;
  } catch (e) {
    flatFileDictState = FlatFileDictState.Error;
    // If we fail loading the dictionary, make sure to reset it so we can try
    // again!
    flatFileDict = undefined;
    throw e;
  }
  flatFileDictState = FlatFileDictState.Ok;

  bugsnagClient.leaveBreadcrumb('Loaded dictionary successfully');
}

//
// Context menu
//

let menuId: number | string | null = null;

function addContextMenu() {
  if (menuId) {
    return;
  }

  try {
    menuId = browser.contextMenus.create({
      id: 'context-toggle',
      type: 'checkbox',
      title: browser.i18n.getMessage('menu_enable_extension'),
      command: '_execute_browser_action',
      contexts: ['all'],
      checked: enabled,
    });
  } catch (e) {
    // TODO: Chrome doesn't support the 'command' member so if we got an
    // exception, assume that's it and try the old-fashioned way.
  }
}

async function removeContextMenu() {
  if (!menuId) {
    return;
  }

  try {
    await browser.contextMenus.remove(menuId);
  } catch (e) {
    console.error(`Failed to remove context menu: ${e}`);
    bugsnagClient.notify(`Failed to remove context menu: ${e}`, {
      severity: 'warning',
    });
  }

  menuId = null;
}

//
// Tab toggling
//

let enabled: boolean = false;

async function enableTab(tab: browser.tabs.Tab) {
  console.assert(typeof tab.id === 'number', `Unexpected tab ID: ${tab.id}`);

  updateBrowserAction({
    popupStyle: config.popupStyle,
    enabled: true,
    flatFileDictState: FlatFileDictState.Loading,
    kanjiDb,
  });

  if (menuId) {
    browser.contextMenus.update(menuId, { checked: true });
  }

  try {
    await Promise.all([loadDictionary(), config.ready]);

    // Trigger download but don't wait on it. We don't block on this because
    // we currently only download the kanji data and we don't need it to be
    // downloaded before we can do something useful.
    maybeDownloadData();

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
    browser.storage.local.set({ enabled: true });

    updateBrowserAction({
      popupStyle: config.popupStyle,
      enabled: true,
      flatFileDictState,
      kanjiDb,
    });
  } catch (e) {
    bugsnagClient.notify(e || '(No error)', { severity: 'error' });

    updateBrowserAction({
      popupStyle: config.popupStyle,
      enabled: true,
      flatFileDictState,
      kanjiDb,
    });

    // Reset internal state so we can try again
    flatFileDict = undefined;

    if (menuId) {
      browser.contextMenus.update(menuId, { checked: false });
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
    flatFileDictState,
    kanjiDb,
  });

  if (menuId) {
    browser.contextMenus.update(menuId, { checked: false });
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

function toggle(tab: browser.tabs.Tab) {
  if (enabled) {
    disableAll();
  } else {
    bugsnagClient.leaveBreadcrumb('Enabling tab from toggle');
    enableTab(tab);
  }
}

//
// Search
//

let dictCount: number = 3;
let kanjiDictIndex: number = 1;
let nameDictIndex: number = 2;
let showIndex: number = 0;

function search(text: string, dictOption: DictMode) {
  if (!flatFileDict) {
    console.error('Dictionary not initialized in search');
    bugsnagClient.notify('Dictionary not initialized in search', {
      severity: 'warning',
    });
    return;
  }

  switch (dictOption) {
    case DictMode.ForceKanji:
      return searchKanji(text.charAt(0));

    case DictMode.Default:
      showIndex = 0;
      break;

    case DictMode.NextDict:
      showIndex = (showIndex + 1) % dictCount;
      break;
  }

  const searchCurrentDict: (text: string) => Promise<SearchResult | null> = (
    text: string
  ) => {
    switch (showIndex) {
      case kanjiDictIndex:
        return searchKanji(text.charAt(0));
      case nameDictIndex:
        return flatFileDict!.wordSearch({
          input: text,
          doNames: true,
          includeRomaji: false,
        });
    }
    return flatFileDict!.wordSearch({
      input: text,
      doNames: false,
      includeRomaji: config.showRomaji,
    });
  };

  const originalMode = showIndex;
  return (function loopOverDictionaries(text): Promise<SearchResult | null> {
    return searchCurrentDict(text).then(result => {
      if (result) {
        return result;
      }
      showIndex = (showIndex + 1) % dictCount;
      if (showIndex === originalMode) {
        return null;
      }
      return loopOverDictionaries(text);
    });
  })(text);
}

async function searchKanji(kanji: string): Promise<KanjiResult | null> {
  // Pre-check (might not be needed anymore)
  const codepoint = kanji.charCodeAt(0);
  if (codepoint < 0x3000) {
    return null;
  }

  let result;
  try {
    result = await kanjiDb.getKanji([kanji]);
  } catch (e) {
    console.error(e);
    bugsnagClient.notify(e || '(Error looking up kanji)', {
      severity: 'error',
    });
    return null;
  }

  if (!result.length) {
    return null;
  }

  if (result.length > 1) {
    bugsnagClient.notify(`Got more than one result for ${kanji}`, {
      severity: 'warning',
    });
  }

  return result[0];
}

//
// Browser event handlers
//

browser.tabs.onActivated.addListener(activeInfo => {
  onTabSelect(activeInfo.tabId);
});

browser.browserAction.onClicked.addListener(toggle);

browser.runtime.onMessage.addListener(
  (
    request: any,
    sender: browser.runtime.MessageSender
  ): void | Promise<any> => {
    if (typeof request.type !== 'string') {
      return;
    }

    switch (request.type) {
      case 'enable?':
        if (sender.tab && typeof sender.tab.id === 'number') {
          onTabSelect(sender.tab.id);
        } else {
          console.error('No sender tab in enable? request');
          bugsnagClient.leaveBreadcrumb('No sender tab in enable? request');
        }
        break;

      case 'xsearch':
        if (
          typeof request.text === 'string' &&
          typeof request.dictOption === 'number'
        ) {
          return search(request.text as string, request.dictOption as DictMode);
        }
        console.error(
          `Unrecognized xsearch request: ${JSON.stringify(request)}`
        );
        bugsnagClient.notify(
          `Unrecognized xsearch request: ${JSON.stringify(request)}`,
          {
            severity: 'warning',
          }
        );
        break;

      case 'translate':
        if (flatFileDict) {
          return flatFileDict.translate({
            text: request.title,
            includeRomaji: config.showRomaji,
          });
        }
        console.error('Dictionary not initialized in translate request');
        bugsnagClient.notify(
          'Dictionary not initialized in translate request',
          {
            severity: 'warning',
          }
        );
        break;

      case 'toggleDefinition':
        config.toggleReadingOnly();
        break;

      case 'reportWarning':
        console.assert(
          typeof request.message === 'string',
          '`message` should be a string'
        );
        bugsnagClient.notify(request.message, { severity: 'warning' });
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

browser.runtime.onInstalled.addListener(maybeDownloadData);

browser.runtime.onStartup.addListener(maybeDownloadData);

// See if we were enabled on the last run
//
// We don't do this in onStartup because that won't run when the add-on is
// reloaded and we want to re-enable ourselves in that case too.
(async function() {
  const getEnabledResult = await browser.storage.local.get('enabled');
  const wasEnabled =
    getEnabledResult &&
    getEnabledResult.hasOwnProperty('enabled') &&
    getEnabledResult.enabled;

  if (wasEnabled) {
    const tabs = await browser.tabs.query({
      currentWindow: true,
      active: true,
    });
    if (tabs && tabs.length) {
      bugsnagClient.leaveBreadcrumb(
        'Loading because we were enabled on the previous run'
      );
      enableTab(tabs[0]);
    }
  }
})();
