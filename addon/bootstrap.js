/**
 * Zotero plugin bootstrap.
 *
 * Zotero calls these functions from its own `Zotero.Plugins` loader:
 * `install`, `startup`, `shutdown`, `uninstall`, plus `onMainWindowLoad` /
 * `onMainWindowUnload` for every main window. Unlike Firefox, Zotero keeps
 * plugins loaded for the whole session and only calls `shutdown` on disable,
 * uninstall or app quit.
 *
 * This file runs in a Gecko sandbox that exposes `Zotero`, `Services`,
 * `Components`, `IOUtils`, `PathUtils`, `fetch`, `setTimeout` and friends as
 * globals — see `_loadScope()` in Zotero's `xpcom/plugins.js`. Notably there is
 * no `window` and no `document` here; UI work is delegated to the plugin bundle
 * via the `onMainWindowLoad` hook.
 *
 * The bundle in `content/scripts/` is a single esbuild output holding every
 * source module, so there is exactly one `loadSubScript` call.
 */

var chromeHandle;

/**
 * Registers the plugin's `content/` directory under
 * `chrome://<addonRef>/content/…`, which is the only way to reach static assets
 * (icons, XHTML, CSS, `.ftl`) from privileged Zotero code.
 */
function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", rootURI + "content/"],
  ]);

  /**
   * `_globalThis` must be the sandbox root so that variables declared at the
   * top level of the bundle (notably the addon instance) stay reachable after
   * `loadSubScript` returns.
   *
   * `rootURI` is published here because the bundle needs it to register the
   * preferences pane with absolute `moz-extension://` URLs.
   */
  const ctx = { rootURI };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}content/scripts/__addonRef__.js`,
    ctx,
  );

  await Zotero.__addonInstance__.hooks.onStartup();
}

async function onMainWindowLoad({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, reason) {
  await Zotero.__addonInstance__?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  // APP_SHUTDOWN means Zotero is quitting: tearing down UI here would race with
  // Gecko's own window teardown, and the process is about to exit anyway.
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await Zotero.__addonInstance__?.hooks.onShutdown();

  // Release the chrome registration or a reinstall in the same session fails
  // with "cannot register chrome" for the same namespace.
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function uninstall(data, reason) {}
