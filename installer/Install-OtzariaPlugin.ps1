#requires -Version 5.1
<#
  מבקש מאוצריא להתקין את קובץ ה-.otzplugin שהמתקין פרס.

  הסקריפט מורץ מ-[Run] עם runasoriginaluser, כלומר בהקשר של המשתמש שהפעיל את
  המתקין ולא של החשבון המורם. זה מכוון: רישום הפרוטוקול `otzaria://` וגם
  התקנת אוצריא עצמה יושבים בדרך כלל ב-HKCU וב-%LOCALAPPDATA% של אותו משתמש,
  ולכן רק תהליך שרץ תחתיו יכול למצוא אותם.

  סדר הניסיונות:
    1. הפעלת otzaria.exe ישירות עם נתיב קובץ התוסף — עובד גם כשפרוטוקול
       `otzaria://` אינו רשום (התקנה ניידת של אוצריא).
    2. נפילה לקישור `otzaria://plugin/install-local`.
    3. הודעה למשתמש עם נתיב הקובץ להתקנה ידנית.

  כל ריצה נרשמת ל-%TEMP%\otzaria-hebrewbooks-plugin-install.log.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $PluginPath
)

$ErrorActionPreference = 'Stop'

$script:LogPath = if ([string]::IsNullOrWhiteSpace($env:TEMP)) {
  'otzaria-hebrewbooks-plugin-install.log'
} else {
  Join-Path $env:TEMP 'otzaria-hebrewbooks-plugin-install.log'
}

function Write-Log {
  param([string] $Message)
  $line = '[{0}] {1}' -f (Get-Date -Format 's'), $Message
  try {
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
  } catch {
    # לוג הוא best-effort בלבד; כישלון בכתיבה לא אמור להפיל את ההתקנה.
  }
}

function Show-Message {
  param([string] $Message)

  # WScript.Shell ולא MessageBox: הסקריפט מורץ עם waituntilterminated מעל חלון
  # האשף, ו-vbSystemModal (0x1000) מבטיח שההודעה לא תיקבר מאחוריו. הפסק-זמן
  # של שתי דקות מונע מהמתקין להיתקע אם המשתמש עזב את המחשב.
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shell.Popup($Message, 120, 'HebrewBooks לאוצריא', 0x30 -bor 0x1000) | Out-Null
    return
  } catch {
    Write-Log "WScript.Shell popup failed: $($_.Exception.Message)"
  }

  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $Message,
      'HebrewBooks לאוצריא',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
  } catch {
    # ללא WinForms (Server Core וכדומה) — הלוג הוא הערוץ היחיד שנותר.
    Write-Log "Failed to show message box: $($_.Exception.Message)"
  }
}

# חילוץ נתיב ה-EXE מערך `shell\open\command` בצורת `"C:\...\otzaria.exe" "%1"`.
function Get-ExecutableFromCommand {
  param([string] $Command)

  $value = $Command.Trim()
  if ([string]::IsNullOrEmpty($value)) { return $null }

  if ($value.StartsWith('"')) {
    $end = $value.IndexOf('"', 1)
    if ($end -lt 0) { return $null }
    return $value.Substring(1, $end - 1)
  }

  $space = $value.IndexOf(' ')
  if ($space -lt 0) { return $value }
  return $value.Substring(0, $space)
}

function Get-RegistryValue {
  param([string] $Path, [string] $Name)
  try {
    $key = Get-Item -LiteralPath $Path -ErrorAction Stop
    return $key.GetValue($Name)
  } catch {
    return $null
  }
}

function Get-OtzariaExecutable {
  $candidates = New-Object System.Collections.Generic.List[string]

  # 1. מטפל הפרוטוקול הרשום. HKCU קודם — התקנת ברירת המחדל של אוצריא
  #    היא למשתמש הנוכחי (PrivilegesRequired=lowest).
  foreach ($key in @(
      'Registry::HKEY_CURRENT_USER\Software\Classes\otzaria\shell\open\command',
      'Registry::HKEY_LOCAL_MACHINE\Software\Classes\otzaria\shell\open\command',
      'Registry::HKEY_CLASSES_ROOT\otzaria\shell\open\command'
    )) {
    $command = Get-RegistryValue -Path $key -Name ''
    if ($command) {
      $exe = Get-ExecutableFromCommand -Command ([string]$command)
      if ($exe) { $candidates.Add($exe) }
    }
  }

  # 2. רשומת ההסרה של אוצריא (AppId של Inno + הסיומת _is1).
  $appId = '{EEC4F712-CD05-4D15-A753-509E840A51A5}_is1'
  foreach ($key in @(
      "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\$appId",
      "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\$appId",
      "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$appId"
    )) {
    $location = Get-RegistryValue -Path $key -Name 'InstallLocation'
    if ($location) {
      $candidates.Add((Join-Path ([string]$location) 'otzaria.exe'))
    }
  }

  # 3. מיקומי ברירת המחדל ({autopf}\Otzaria בשני מצבי ההתקנה).
  $roots = @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $roots = @((Join-Path $env:LOCALAPPDATA 'Programs')) + $roots
  }
  foreach ($root in $roots) {
    $candidates.Add((Join-Path $root 'Otzaria\otzaria.exe'))
  }

  # 4. PATH — מתקין אוצריא מוסיף אליו את תיקיית ההתקנה.
  $onPath = Get-Command 'otzaria.exe' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($onPath) { $candidates.Add($onPath.Source) }

  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and
        (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).ProviderPath
    }
  }

  return $null
}

Write-Log "Requested plugin install: $PluginPath"

# LiteralPath — נתיב ההתקנה עשוי להכיל תווים שנחשבים wildcard ([ ]).
try {
  $resolvedPluginPath = (Resolve-Path -LiteralPath $PluginPath).ProviderPath
} catch {
  Write-Log "Plugin archive not found: $($_.Exception.Message)"
  Show-Message ("קובץ התוסף לא נמצא בנתיב:`r`n$PluginPath`r`n`r`n" +
    'התקן מחדש את התוכנה, או התקן את התוסף ידנית ממסך התוספים באוצריא.')
  exit 1
}

# אוצריא מזהה ארגומנט שמסתיים ב-.otzplugin וממירה אותו בעצמה לבקשת התקנה,
# ולכן ההפעלה הישירה אינה תלויה ברישום פרוטוקול כלשהו.
try {
  $otzariaExe = Get-OtzariaExecutable
} catch {
  Write-Log "Executable discovery failed: $($_.Exception.Message)"
  $otzariaExe = $null
}

if ($otzariaExe) {
  Write-Log "Launching Otzaria directly: $otzariaExe"
  try {
    Start-Process -FilePath $otzariaExe -ArgumentList "`"$resolvedPluginPath`"" | Out-Null
    Write-Log 'Otzaria launched successfully.'
    exit 0
  } catch {
    Write-Log "Direct launch failed: $($_.Exception.Message)"
  }
} else {
  Write-Log 'Otzaria executable was not found; falling back to the otzaria:// protocol.'
}

$installUri = 'otzaria://plugin/install-local?path=' +
  [Uri]::EscapeDataString($resolvedPluginPath)
Write-Log "Launching protocol handler: $installUri"
try {
  Start-Process $installUri | Out-Null
  Write-Log 'Protocol handler launched successfully.'
  exit 0
} catch {
  Write-Log "Protocol launch failed: $($_.Exception.Message)"
}

Show-Message ("לא ניתן היה לפתוח את אוצריא כדי להשלים את התקנת התוסף." +
  "`r`n`r`nשירות החיפוש הותקן בהצלחה. להתקנת התוסף פתח את אוצריא, גש אל" +
  " הגדרות ← כלים, ובחר בהתקנת תוסף מקובץ:`r`n$resolvedPluginPath" +
  "`r`n`r`nפירוט טכני:`r`n$script:LogPath")
exit 1
