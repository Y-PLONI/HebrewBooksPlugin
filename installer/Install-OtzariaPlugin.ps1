[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $PluginPath
)

$resolvedPluginPath = (Resolve-Path $PluginPath).Path
$installUri = 'otzaria://plugin/install-local?path=' +
  [Uri]::EscapeDataString($resolvedPluginPath)
Start-Process $installUri
