# Preferences pane strings for Zotero LLM Summarizer.
#
# The file name must match the `<html:link rel="localization">` href in
# content/preferences.xhtml. Zotero loads these through the shared
# `zotero-plugins:` L10n source (see registerLocales() in xpcom/plugins.js), so
# a new `Localization(["llmsummarizer-preferences.ftl"], true)` resolves here.

pref-api-section = Model API
pref-provider = Provider preset
pref-baseurl = API Base URL
pref-apikey = API Key
pref-model = Model Name
pref-temperature = Temperature
pref-maxchars = Max characters
pref-timeout = Timeout (seconds)
pref-language = Output language
pref-debug = Write debug output to the Help → Debug Output Log

pref-prompt-section = Prompt templates
pref-prompt-name = Template name
pref-prompt-body = Template content

pref-help =
    Placeholders: {{content}} full text, {{title}} title, {{creators}} authors,
    {{year}} year, {{publication}} journal or conference.
