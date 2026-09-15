import { buildTime, buildVersion, log } from "./utils/env";
import { MenuManager } from "./modules/menuManager";
import { PreferencePane } from "./modules/preference";

/**
 * Plugin entry point.
 *
 * `addon/bootstrap.js` loads this bundle with `Services.scriptloader.loadSubScript`
 * into a sandbox whose global object is exposed as `_globalThis`. Everything the
 * bootstrap needs afterwards must therefore hang off that global, which is what
 * `installAddon()` below arranges.
 *
 * Lifecycle, as called by Zotero from `bootstrap.js`:
 *
 *   startup()            → installAddon()          — build modules, register the prefs pane
 *   onMainWindowLoad(w)  → addToWindow(w)          — inject the item context menu
 *   onMainWindowUnload   → removeFromWindow(w)     — detach listeners and DOM nodes
 *   shutdown()           → shutdown()              — unregister the pane and clean up
 *
 * `onMainWindowLoad` is called once per open main window and again for every
 * window opened later (and once immediately at startup for existing windows), so
 * all per-window state lives in `MenuManager`'s `WeakMap`-like registry rather
 * than in module-level variables.
 */

export interface AddonHooks {
  onStartup(): Promise<void>;
  onMainWindowLoad(window: Window): void;
  onMainWindowUnload(window: Window): void;
  onShutdown(): Promise<void>;
  /**
   * Dispatcher for the preferences pane's inline handlers. Zotero compiles
   * inline `onload` / `oncommand` attributes in a pane fragment, and those
   * attributes evaluate in the preferences window — so they must reach this
   * object through the global plugin instance:
   * `Zotero.LLMSummarizer.hooks.onPrefsEvent('testConnection', { window })`.
   */
  onPrefsEvent(type: string, data?: Record<string, unknown>): Promise<void> | void;
}

class Addon {
  readonly addonRef: string;
  readonly pluginID: string;

  private menuManager: MenuManager | null = null;
  private preferencePane: PreferencePane | null = null;
  private initialized = false;

  constructor(addonRef: string, pluginID: string) {
    this.addonRef = addonRef;
    this.pluginID = pluginID;
  }

  /**
   * `hooks` is the object `bootstrap.js` reaches through
   * `Zotero.<addonInstance>.hooks`, and the preferences pane's inline handlers
   * reach through `Zotero.<addonInstance>.hooks.onPrefsEvent(...)`.
   */
  readonly hooks: AddonHooks = {
    onStartup: async () => {
      await this.onStartup();
    },
    onMainWindowLoad: (window: Window) => this.onMainWindowLoad(window),
    onMainWindowUnload: (window: Window) => this.onMainWindowUnload(window),
    onShutdown: async () => {
      await this.onShutdown();
    },
    onPrefsEvent: (type: string, data?: Record<string, unknown>) =>
      this.preferencePane?.onPrefsEvent(type, data as never),
  };

  private async onStartup(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    // The build stamp matters when installing by hand: the manifest version
    // does not change between iterations, so this line is the only way to tell
    // whether the build you just packaged is the one actually loaded.
    log(`Starting ${this.pluginID} v${buildVersion} (built ${buildTime})`);

    // Registering the preference pane first means a half-initialised plugin
    // still exposes its settings, so users can fix a bad configuration.
    this.preferencePane = new PreferencePane(this.addonRef, this.pluginID);
    this.menuManager = new MenuManager(this.addonRef);

    // Windows already open at plugin-install time: Zotero replays
    // `onMainWindowLoad` for them, but only if the plugin was started before the
    // window; covering both paths here is harmless because `addToWindow` is
    // idempotent.
    for (const window of Zotero.getMainWindows()) {
      this.menuManager.addToWindow(window);
    }

    log("Startup complete");
  }

  private onMainWindowLoad(window: Window): void {
    this.menuManager?.addToWindow(window);
  }

  private onMainWindowUnload(window: Window): void {
    this.menuManager?.removeFromWindow(window);
  }

  private async onShutdown(): Promise<void> {
    log("Shutting down");
    this.menuManager?.removeAll();
    this.menuManager = null;
    this.preferencePane?.unregister();
    this.preferencePane = null;
    this.initialized = false;
  }

  /** Entry point for the preferences pane's inline event handlers. */
  onPrefsEvent(type: string, data?: Record<string, unknown>): Promise<void> | void {
    return this.preferencePane?.onPrefsEvent(type, data as never);
  }
}

/**
 * Wires the instance into the two globals the rest of the plugin needs.
 *
 * `_globalThis` is the sandbox root created by `bootstrap.js`; assigning the
 * instance there is what makes `hooks` survive beyond this module's evaluation.
 */
function installAddon(addonRef: string, pluginID: string, instanceName: string): void {
  const scope = _globalThis as Record<string, unknown>;

  if (!scope.addon) {
    const addon = new Addon(addonRef, pluginID);
    scope.addon = addon;

    // The single handle everything else uses: Zotero's bootstrap
    // (`Zotero.<instanceName>.hooks.*`), the preferences pane's inline handlers,
    // and console debugging. Must match `config.addonInstance` in package.json.
    (Zotero as unknown as Record<string, unknown>)[instanceName] = addon;
  }
}

installAddon("llmsummarizer", "llm-summarizer@yourdomain.org", "LLMSummarizer");

export { Addon };
