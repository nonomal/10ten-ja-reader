// This is a wrapper about the browser.sync.settings API which provides
// following important features:
//
// * Only options that are explicitly set get saved. (This prevents the
//   FoxClocks problem where, when you install the FoxClocks add-on on a new
//   computer it sets all the settings to their default values before a sync
//   happens so then all other synchronized computers end up having their
//   settings reset to their default values.)
//
// * Provides a snapshot of all options with their default values filled-in for
//   passing to the content process.

import Bugsnag from '@bugsnag/browser';
import { browser } from 'webextension-polyfill-ts';

import { dbLanguages, DbLanguageId } from './db-languages';
import { ExtensionStorageError } from './extension-storage-error';
import {
  AccentDisplay,
  ContentConfig,
  KeyboardKeys,
  PartOfSpeechDisplay,
  TabDisplay,
} from './content-config';
import {
  ReferenceAbbreviation,
  convertLegacyReference,
  getReferencesForLang,
} from './refs';
import { stripFields } from './strip-fields';

// We represent the set of references that have been turned on as a series
// of true or false values.
//
// It might seem like it's sufficient to just store the _set_ values (or
// vice-versa) but that complicates matters when we introduce a new reference
// type or change the default value of an existing reference type. Currently all
// references as enabled by default, but we may wish to add a new reference type
// that is disabled by default, or conditionally enabled by default (e.g. if we
// find data for JLPT Nx levels, we might want to only enable it if the user has
// already got the existing JLPT data enabled).
//
// By recording the references that have actually been changed by the user as
// being either enabled or disabled we capture the user's intention more
// accurately. Anything not set should use the default setting.
type KanjiReferenceFlagsV2 = { [key in ReferenceAbbreviation]?: boolean };

// Although we separate out the keys for moving a pop-up up or down when we
// report the keys to the content page, we store them as a single setting.
type StoredKeyboardKeys = Omit<
  KeyboardKeys,
  'movePopupUp' | 'movePopupDown'
> & {
  movePopupDownOrUp: string[];
};

interface Settings {
  accentDisplay?: AccentDisplay;
  contextMenuEnable?: boolean;
  dictLang?: DbLanguageId;
  hasSwitchedDictionary?: boolean;
  holdToShowKeys?: string;
  holdToShowImageKeys?: string;
  kanjiReferencesV2?: KanjiReferenceFlagsV2;
  keys?: Partial<StoredKeyboardKeys>;
  noTextHighlight?: boolean;
  popupStyle?: string;
  posDisplay?: PartOfSpeechDisplay;
  readingOnly?: boolean;
  showKanjiComponents?: boolean;
  showPriority?: boolean;
  showRomaji?: boolean;
  tabDisplay?: TabDisplay;
  toolbarIcon?: 'default' | 'sky';
}

type StorageChange = {
  oldValue?: any;
  newValue?: any;
};
type ChangeDict = { [field: string]: StorageChange };
type ChangeCallback = (changes: ChangeDict) => void;

// A single key description. We use this definition for storing the default keys
// since it allows storing as an array (so we can determine the order the
// options are displayed in) and storing a description along with each key.
interface KeySetting {
  name: keyof StoredKeyboardKeys;
  keys: string[];
  enabledKeys: string[];
  l10nKey: string;
}

export const DEFAULT_KEY_SETTINGS: KeySetting[] = [
  {
    name: 'nextDictionary',
    keys: ['Shift', 'Enter', 'n'],
    enabledKeys: ['Shift', 'Enter'],
    l10nKey: 'options_popup_switch_dictionaries',
  },
  {
    name: 'kanjiLookup',
    keys: ['Shift'],
    enabledKeys: [],
    l10nKey: 'options_popup_kanji_lookup',
  },
  {
    name: 'toggleDefinition',
    keys: ['d'],
    enabledKeys: [],
    l10nKey: 'options_popup_toggle_definition',
  },
  {
    name: 'movePopupDownOrUp',
    keys: ['j,k'],
    enabledKeys: [],
    l10nKey: 'options_popup_move_popup_down_or_up',
  },
  {
    name: 'startCopy',
    keys: ['c'],
    enabledKeys: ['c'],
    l10nKey: 'options_popup_start_copy',
  },
];

// The following references were added to this extension in a later version and
// so we turn them off by default to avoid overwhelming users with too many
// references.
const OFF_BY_DEFAULT_REFERENCES: Set<ReferenceAbbreviation> = new Set([
  'busy_people',
  'kanji_in_context',
  'kodansha_compact',
  'maniette',
]);

export class Config {
  private _settings: Settings = {};
  private _readPromise: Promise<void>;
  private _changeListeners: ChangeCallback[] = [];
  private _previousDefaultLang: DbLanguageId;

  constructor() {
    this._readPromise = this._readSettings();
    this._previousDefaultLang = this.getDefaultLang();

    this.onChange = this.onChange.bind(this);
    browser.storage.onChanged.addListener(this.onChange);

    this.onLanguageChange = this.onLanguageChange.bind(this);
    window.addEventListener('languagechange', this.onLanguageChange);
  }

  async _readSettings() {
    let settings;
    try {
      settings = await browser.storage.sync.get(null);
    } catch (e) {
      settings = {};
    }
    this._settings = settings;
    await this.upgradeSettings();
  }

  async upgradeSettings() {
    // If we have old kanji reference settings but not new ones, upgrade them.
    if (
      this._settings.hasOwnProperty('kanjiReferences') &&
      !this._settings.kanjiReferencesV2
    ) {
      const newSettings: KanjiReferenceFlagsV2 = {};
      const existingSettings: { [key: string]: boolean } = (
        this._settings as any
      ).kanjiReferences;
      for (const [ref, enabled] of Object.entries(existingSettings)) {
        const newRef = convertLegacyReference(ref);
        if (newRef) {
          newSettings[newRef] = enabled;
        }
      }

      this._settings.kanjiReferencesV2 = newSettings;
      try {
        await browser.storage.sync.set({
          kanjiReferencesV2: newSettings,
        });
      } catch (_) {
        // If we failed to store the upgraded settings that's fine since at
        // least the in-memory version of the settings has been upgraded.
        // We'll try upgrading the stored settings next time we're loaded
        // anyway.
        console.error('Failed to upgrade kanji references settings');
      }
    }
  }

  get ready(): Promise<void> {
    return this._readPromise;
  }

  async onChange(changes: ChangeDict, areaName: string) {
    if (areaName !== 'sync') {
      return;
    }

    // Re-read settings in case the changes were made by a different instance of
    // this class.
    await this._readSettings();

    // Fill in default setting values
    const updatedChanges: ChangeDict = { ...changes };
    for (const key of Object.keys(updatedChanges)) {
      switch (key) {
        case 'dictLang':
          updatedChanges.dictLang = { ...changes.dictLang };
          if (!updatedChanges.dictLang.newValue) {
            updatedChanges.dictLang.newValue = this.dictLang;
          }
          if (!updatedChanges.dictLang.oldValue) {
            updatedChanges.dictLang.oldValue = this._previousDefaultLang;
          }
          break;

        // Following is just the set of properties we know we actually inspect
        // the `newValue` of. We don't have a convenient means of fetching the
        // default value to fill in the oldValue, but we don't currently need
        // it either.
        case 'contextMenuEnable':
        case 'popupStyle':
        case 'toolbarIcon':
          updatedChanges[key] = { ...changes[key] };
          if (
            typeof updatedChanges[key].newValue === 'undefined' ||
            updatedChanges[key].newValue === null
          ) {
            updatedChanges[key].newValue = this[key];
          }
          break;
      }
    }

    for (const listener of this._changeListeners) {
      listener(updatedChanges);
    }
  }

  addChangeListener(callback: ChangeCallback) {
    if (this._changeListeners.indexOf(callback) !== -1) {
      return;
    }
    this._changeListeners.push(callback);
  }

  removeChangeListener(callback: ChangeCallback) {
    const index = this._changeListeners.indexOf(callback);
    if (index === -1) {
      return;
    }
    this._changeListeners.splice(index, 1);
  }

  // accentDisplay: Defaults to binary

  get accentDisplay(): AccentDisplay {
    return typeof this._settings.accentDisplay === 'undefined'
      ? 'binary'
      : this._settings.accentDisplay;
  }

  set accentDisplay(value: AccentDisplay) {
    if (
      typeof this._settings.accentDisplay !== 'undefined' &&
      this._settings.accentDisplay === value
    ) {
      return;
    }

    this._settings.accentDisplay = value;
    browser.storage.sync.set({ accentDisplay: value });
  }

  // contextMenuEnable: Defaults to true

  get contextMenuEnable(): boolean {
    return (
      typeof this._settings.contextMenuEnable === 'undefined' ||
      this._settings.contextMenuEnable
    );
  }

  set contextMenuEnable(value: boolean) {
    if (
      typeof this._settings.contextMenuEnable !== 'undefined' &&
      this._settings.contextMenuEnable === value
    ) {
      return;
    }

    this._settings.contextMenuEnable = value;
    browser.storage.sync.set({ contextMenuEnable: value });
  }

  // dictLang: Defaults to the first match from navigator.languages found in
  // dbLanguages, or 'en' otherwise.

  get dictLang(): DbLanguageId {
    return this.useDefaultLang()
      ? this.getDefaultLang()
      : this._settings.dictLang!;
  }

  private useDefaultLang(): boolean {
    // Check that the language that is set is valid. It might be invalid if we
    // deprecated a language or we synced a value from a newer version of the
    // extension.
    if (this._settings.dictLang) {
      return !dbLanguages.includes(this._settings.dictLang);
    }

    return true;
  }

  private getDefaultLang(): DbLanguageId {
    const availableLanguages = new Set(dbLanguages);
    for (const lang of navigator.languages) {
      const langCode = lang.split('-')[0];
      if (availableLanguages.has(langCode as DbLanguageId)) {
        return langCode as DbLanguageId;
      }
    }

    return 'en';
  }

  set dictLang(value: DbLanguageId) {
    if (this._settings.dictLang && this._settings.dictLang === value) {
      return;
    }

    // Note that we don't need to check that `value` is valid since TypeScript
    // does that for us.

    // If the value to set matches the default we clear the setting. This is so
    // that if we later support one of the user's more preferred languages we
    // can update them automatically.
    if (value === this.getDefaultLang()) {
      browser.storage.sync.remove('dictLang').catch(() => {
        Bugsnag.notify(
          new ExtensionStorageError({ key: 'dictLang', action: 'remove' }),
          (event) => {
            event.severity = 'warning';
          }
        );
      });
      delete this._settings.dictLang;
    } else {
      browser.storage.sync.set({ dictLang: value }).catch(() => {
        Bugsnag.notify(
          new ExtensionStorageError({ key: 'dictLang', action: 'set' }),
          (event) => {
            event.severity = 'warning';
          }
        );
      });
      this._settings.dictLang = value;
    }
  }

  onLanguageChange() {
    // If the user's accept-languages setting changed AND we are basing the
    // dictLang value on that we should notify listeners of the change.
    if (!this.useDefaultLang()) {
      return;
    }

    const newValue = this.getDefaultLang();
    if (this._previousDefaultLang !== newValue) {
      const oldValue = this._previousDefaultLang;
      this._previousDefaultLang = newValue;
      const changes: ChangeDict = { dictLang: { newValue, oldValue } };
      for (const listener of this._changeListeners) {
        listener(changes);
      }
    }
  }

  // hasSwitchedDictionary: Defaults to false

  get hasSwitchedDictionary(): boolean {
    return !!this._settings.hasSwitchedDictionary;
  }

  setHasSwitchedDictionary() {
    if (this._settings.hasSwitchedDictionary) {
      return;
    }

    this._settings.hasSwitchedDictionary = true;
    browser.storage.sync.set({ hasSwitchedDictionary: true });
  }

  // holdToShowKeys: Defaults to null

  get holdToShowKeys(): string | null {
    return typeof this._settings.holdToShowKeys === 'string'
      ? this._settings.holdToShowKeys
      : null;
  }

  set holdToShowKeys(value: string | null) {
    const storedSetting = this._settings.holdToShowKeys || null;
    if (value === storedSetting) {
      return;
    }

    if (value === null) {
      browser.storage.sync.remove('holdToShowKeys');
      delete this._settings.holdToShowKeys;
    } else {
      browser.storage.sync.set({ holdToShowKeys: value });
      this._settings.holdToShowKeys = value;
    }

    // If holdToShowImageKeys was mirroring this setting, save the previous
    // value as its own value.
    if (typeof this._settings.holdToShowImageKeys === 'undefined') {
      this.holdToShowImageKeys = storedSetting;
    }
    // Otherwise, if we have cleared this setting and holdToShowImageKeys was
    // storing 'none' just to differentiate itself from us, we can clear that
    // stored value now.
    else if (!value && this._settings.holdToShowImageKeys === 'none') {
      this.holdToShowImageKeys = null;
    }
  }

  // holdToShowImageKeys: Default is... complicated.
  //
  // This setting was introduced after the "holdToShowKeys" setting was
  // introduced and we want the default behavior to be:
  //
  // - For new users, nothing, since that's the default for "holdToShow" keys
  //   and it makes sense to surface this by default and let users who find it
  //   annoying turn it off.
  //
  // - For users who have previously configured a "holdToShowKeys" setting,
  //   the same value as the "holdToShowKeys" setting since previously that
  //   setting controlled this behavior.
  //
  // But how do we distinguish between a user who has previously configured the
  // "holdToShowKeys" setting (meaning we should mirror that value here) vs one
  // who has configured the "holdToShowKeys" setting _since_ this setting was
  // introduced and deliberately wants different behavior to that setting?
  //
  // We achieve that by deliberately storing "none" as the value for this
  // setting any time we alter the "holdToShowKeys" setting while this is null.

  get holdToShowImageKeys(): string | null {
    // If there is an explicit setting for this value, use that.
    if (typeof this._settings.holdToShowImageKeys === 'string') {
      return this._settings.holdToShowImageKeys === 'none'
        ? null
        : this._settings.holdToShowImageKeys;
    }

    // Otherwise, mirror the holdToShowKeys setting
    return this.holdToShowKeys;
  }

  set holdToShowImageKeys(value: string | null) {
    // If this is null AND holdToShowKeys is null, then we can clear the local
    // setting. We only need to store 'none' if holdToShowKeys is set (in order
    // to ensure we DON'T mirror that setting).
    const settingToStore =
      value === null && this.holdToShowKeys ? 'none' : value;

    // Ignore null-op changes
    const storedSetting = this._settings.holdToShowImageKeys || null;
    if (settingToStore === storedSetting) {
      return;
    }

    if (settingToStore === null) {
      browser.storage.sync.remove('holdToShowImageKeys');
      delete this._settings.holdToShowImageKeys;
    } else {
      browser.storage.sync.set({ holdToShowImageKeys: settingToStore });
      this._settings.holdToShowImageKeys = settingToStore;
    }
  }

  // kanjiReferences: Defaults to true for all but a few references
  // that were added more recently.

  get kanjiReferences(): Array<ReferenceAbbreviation> {
    const setValues = this._settings.kanjiReferencesV2 || {};
    const result: Array<ReferenceAbbreviation> = [];
    for (const ref of getReferencesForLang(this.dictLang)) {
      if (typeof setValues[ref] === 'undefined') {
        if (!OFF_BY_DEFAULT_REFERENCES.has(ref)) {
          result.push(ref);
        }
      } else if (setValues[ref]) {
        result.push(ref);
      }
    }
    return result;
  }

  updateKanjiReferences(updatedReferences: KanjiReferenceFlagsV2) {
    const existingSettings = this._settings.kanjiReferencesV2 || {};
    this._settings.kanjiReferencesV2 = {
      ...existingSettings,
      ...updatedReferences,
    };
    browser.storage.sync.set({
      kanjiReferencesV2: this._settings.kanjiReferencesV2,
    });
  }

  // keys: Defaults are defined by DEFAULT_KEY_SETTINGS, and particularly the
  // enabledKeys member.

  private getDefaultEnabledKeys(): StoredKeyboardKeys {
    return DEFAULT_KEY_SETTINGS.reduce<Partial<StoredKeyboardKeys>>(
      (defaultKeys, setting) => {
        defaultKeys[setting.name] = setting.enabledKeys;
        return defaultKeys;
      },
      {}
    ) as StoredKeyboardKeys;
  }

  get keys(): StoredKeyboardKeys {
    const setValues = this._settings.keys || {};
    return { ...this.getDefaultEnabledKeys(), ...setValues };
  }

  get keysNormalized(): KeyboardKeys {
    const storedKeys = this.keys;
    const [down, up] = this.keys.movePopupDownOrUp
      .map((key) => key.split(',', 2))
      .reduce<[Array<string>, Array<string>]>(
        ([existingDown, existingUp], [down, up]) => [
          [...existingDown, down],
          [...existingUp, up],
        ],
        [[], []]
      );
    return {
      ...stripFields(storedKeys, ['movePopupDownOrUp']),
      movePopupDown: down,
      movePopupUp: up,
    };
  }

  updateKeys(keys: Partial<StoredKeyboardKeys>) {
    const existingSettings = this._settings.keys || {};
    this._settings.keys = {
      ...existingSettings,
      ...keys,
    };

    browser.storage.sync.set({ keys: this._settings.keys });
  }

  // noTextHighlight: Defaults to false

  get noTextHighlight(): boolean {
    return !!this._settings.noTextHighlight;
  }

  set noTextHighlight(value: boolean) {
    if (
      typeof this._settings.noTextHighlight !== 'undefined' &&
      this._settings.noTextHighlight === value
    ) {
      return;
    }

    this._settings.noTextHighlight = value;
    browser.storage.sync.set({ noTextHighlight: value });
  }

  // popupStyle: Defaults to 'default'

  get popupStyle(): string {
    return typeof this._settings.popupStyle === 'undefined'
      ? 'default'
      : this._settings.popupStyle;
  }

  set popupStyle(value: string) {
    if (
      (typeof this._settings.popupStyle !== 'undefined' &&
        this._settings.popupStyle === value) ||
      (typeof this._settings.popupStyle === 'undefined' && value === 'default')
    ) {
      return;
    }

    if (value !== 'default') {
      this._settings.popupStyle = value;
      browser.storage.sync.set({ popupStyle: value });
    } else {
      this._settings.popupStyle = undefined;
      browser.storage.sync.remove('popupStyle');
    }
  }

  // posDisplay: Defaults to expl

  get posDisplay(): PartOfSpeechDisplay {
    return typeof this._settings.posDisplay === 'undefined'
      ? 'expl'
      : this._settings.posDisplay;
  }

  set posDisplay(value: PartOfSpeechDisplay) {
    if (
      typeof this._settings.posDisplay !== 'undefined' &&
      this._settings.posDisplay === value
    ) {
      return;
    }

    this._settings.posDisplay = value;
    browser.storage.sync.set({ posDisplay: value });
  }

  // readingOnly: Defaults to false

  get readingOnly(): boolean {
    return !!this._settings.readingOnly;
  }

  set readingOnly(value: boolean) {
    if (
      typeof this._settings.readingOnly !== 'undefined' &&
      this._settings.readingOnly === value
    ) {
      return;
    }

    this._settings.readingOnly = value;
    browser.storage.sync.set({ readingOnly: value });
  }

  toggleReadingOnly() {
    this.readingOnly = !this._settings.readingOnly;
  }

  // showKanjiComponents: Defaults to true

  get showKanjiComponents(): boolean {
    return (
      typeof this._settings.showKanjiComponents === 'undefined' ||
      this._settings.showKanjiComponents
    );
  }

  set showKanjiComponents(value: boolean) {
    this._settings.showKanjiComponents = value;
    browser.storage.sync.set({ showKanjiComponents: value });
  }

  // showPriority: Defaults to true

  get showPriority(): boolean {
    return (
      typeof this._settings.showPriority === 'undefined' ||
      this._settings.showPriority
    );
  }

  set showPriority(value: boolean) {
    this._settings.showPriority = value;
    browser.storage.sync.set({ showPriority: value });
  }

  // showRomaji: Defaults to false

  get showRomaji(): boolean {
    return !!this._settings.showRomaji;
  }

  set showRomaji(value: boolean) {
    if (
      typeof this._settings.showRomaji !== 'undefined' &&
      this._settings.showRomaji === value
    ) {
      return;
    }

    this._settings.showRomaji = value;
    browser.storage.sync.set({ showRomaji: value });
  }

  // tabDisplay: Defaults to 'top'

  get tabDisplay(): TabDisplay {
    return typeof this._settings.tabDisplay === 'undefined'
      ? 'top'
      : this._settings.tabDisplay;
  }

  set tabDisplay(value: TabDisplay) {
    if (
      (typeof this._settings.tabDisplay !== 'undefined' &&
        this._settings.tabDisplay === value) ||
      (typeof this._settings.tabDisplay === 'undefined' && value === 'top')
    ) {
      return;
    }

    if (value !== 'top') {
      this._settings.tabDisplay = value;
      browser.storage.sync.set({ tabDisplay: value });
    } else {
      this._settings.tabDisplay = undefined;
      browser.storage.sync.remove('tabDisplay');
    }
  }

  // toolbarIcon: Defaults to 'default'

  get toolbarIcon(): 'default' | 'sky' {
    return typeof this._settings.toolbarIcon === 'undefined'
      ? 'default'
      : this._settings.toolbarIcon;
  }

  set toolbarIcon(value: 'default' | 'sky') {
    if (
      (typeof this._settings.toolbarIcon !== 'undefined' &&
        this._settings.toolbarIcon === value) ||
      (typeof this._settings.toolbarIcon === 'undefined' && value === 'default')
    ) {
      return;
    }

    if (value !== 'default') {
      this._settings.toolbarIcon = value;
      browser.storage.sync.set({ toolbarIcon: value });
    } else {
      this._settings.toolbarIcon = undefined;
      browser.storage.sync.remove('toolbarIcon');
    }
  }

  // Get all the options the content process cares about at once
  get contentConfig(): ContentConfig {
    return {
      accentDisplay: this.accentDisplay,
      dictLang: this.dictLang,
      hasSwitchedDictionary: this.hasSwitchedDictionary,
      // We hide the hold-to-show keys setting in activeTab only mode
      holdToShowKeys:
        !__ACTIVE_TAB_ONLY__ && this.holdToShowKeys
          ? (this.holdToShowKeys.split('+') as Array<'Ctrl' | 'Alt'>)
          : [],
      holdToShowImageKeys:
        !__ACTIVE_TAB_ONLY__ && this.holdToShowImageKeys
          ? (this.holdToShowImageKeys.split('+') as Array<'Ctrl' | 'Alt'>)
          : [],
      kanjiReferences: this.kanjiReferences,
      keys: this.keysNormalized,
      noTextHighlight: this.noTextHighlight,
      popupStyle: this.popupStyle,
      posDisplay: this.posDisplay,
      readingOnly: this.readingOnly,
      showKanjiComponents: this.showKanjiComponents,
      showPriority: this.showPriority,
      showRomaji: this.showRomaji,
      tabDisplay: this.tabDisplay,
    };
  }
}
