#ifndef AppVersion
  #error AppVersion must be supplied with /DAppVersion=X.Y.Z
#endif

#ifndef OutputSuffix
  #define OutputSuffix ""
#endif

#define AppName "HebrewBooks לאוצריא"
#define ServiceId "OtzariaHebrewBooksSearch"
#define ServiceBaseName "HebrewBooksSearchService"
#define ServiceExecutable ServiceBaseName + ".exe"
#define PluginArchive "HebrewBooksPlugin.otzplugin"

[Setup]
AppId={{553757E2-7746-4664-B83B-64EA8BC2548D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=קהילת אוצריא
AppPublisherURL=https://github.com/Y-PLONI/HebrewBooksPlugin
AppSupportURL=https://github.com/Y-PLONI/HebrewBooksPlugin/issues
DefaultDirName={autopf}\Otzaria HebrewBooks Search
DisableProgramGroupPage=yes
PrivilegesRequired=admin
MinVersion=10.0.17763
WizardStyle=modern
Compression=lzma2/normal
SolidCompression=yes
OutputDir=output
OutputBaseFilename=Otzaria-HebrewBooks-Setup-{#AppVersion}{#OutputSuffix}
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\runtime\hbsearch.exe
CloseApplications=no
SetupLogging=yes

[Languages]
Name: "hebrew"; MessagesFile: "compiler:Languages\Hebrew.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "staging\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "staging\plugin\{#PluginArchive}"; DestDir: "{app}\plugin"; Flags: ignoreversion
Source: "Install-OtzariaPlugin.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "licenses\WinSW-LICENSE.txt"; DestDir: "{app}\licenses"; Flags: ignoreversion
Source: "staging\service\{#ServiceExecutable}"; DestDir: "{app}"; Flags: ignoreversion; AfterInstall: InstallAndStartService

[Registry]
Root: HKLM; Subkey: "Software\Otzaria\HebrewBooksSearch"; ValueType: string; ValueName: "DataRoot"; ValueData: "{code:GetDataRoot}"; Flags: uninsdeletekeyifempty

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\installer\Install-OtzariaPlugin.ps1"" -PluginPath ""{app}\plugin\{#PluginArchive}"""; Description: "התקן את התוסף באוצריא"; Flags: postinstall runhidden nowait skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\{#ServiceExecutable}"; Parameters: "stop"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{app}\{#ServiceExecutable}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist

[UninstallDelete]
Type: files; Name: "{app}\{#ServiceBaseName}.xml"
Type: filesandordirs; Name: "{commonappdata}\Otzaria\HebrewBooksSearch\logs"
Type: dirifempty; Name: "{commonappdata}\Otzaria\HebrewBooksSearch"

[Code]
var
  DataRootPage: TInputDirWizardPage;

function XmlEscape(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '&', '&amp;', True);
  StringChangeEx(Result, '<', '&lt;', True);
  StringChangeEx(Result, '>', '&gt;', True);
  StringChangeEx(Result, '"', '&quot;', True);
  StringChangeEx(Result, '''', '&apos;', True);
end;

function SuggestedDataRoot(): String;
var
  SavedDataRoot: String;
begin
  if RegQueryStringValue(HKLM, 'Software\Otzaria\HebrewBooksSearch',
      'DataRoot', SavedDataRoot) and DirExists(SavedDataRoot) then
  begin
    Result := SavedDataRoot;
    Exit;
  end;

  SavedDataRoot := GetEnv('HEBREWBOOKS_DATA');
  if DirExists(SavedDataRoot) then
  begin
    Result := SavedDataRoot;
    Exit;
  end;

  Result := ExpandConstant('{localappdata}\HebrewBooks');
end;

procedure InitializeWizard();
begin
  DataRootPage := CreateInputDirPage(
    wpSelectDir,
    'מיקום נתוני HebrewBooks',
    'בחר את התיקייה הראשית של מאגר HebrewBooks',
    'בתיקייה שנבחרה חייב להימצא הקובץ App\Katalog.db. ' +
      'שירות החיפוש ישתמש בתיקייה זו בכל הפעלה.',
    False,
    ''
  );
  DataRootPage.Add('');
  DataRootPage.Values[0] := SuggestedDataRoot();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  DataRoot: String;
begin
  Result := True;
  if CurPageID <> DataRootPage.ID then
    Exit;

  DataRoot := RemoveBackslashUnlessRoot(Trim(DataRootPage.Values[0]));
  if Copy(DataRoot, 1, 2) = '\\' then
  begin
    MsgBox(
      'שירות Windows אינו יכול להשתמש בנתיב רשת. בחר כונן מקומי או נשלף.',
      mbError,
      MB_OK
    );
    Result := False;
    Exit;
  end;

  if not FileExists(AddBackslash(DataRoot) + 'App\Katalog.db') then
  begin
    MsgBox(
      'לא נמצא App\Katalog.db בתיקייה שנבחרה. בחר את התיקייה הראשית של מאגר HebrewBooks.',
      mbError,
      MB_OK
    );
    Result := False;
    Exit;
  end;

  DataRootPage.Values[0] := DataRoot;
end;

function GetDataRoot(Param: String): String;
begin
  Result := RemoveBackslashUnlessRoot(Trim(DataRootPage.Values[0]));
end;

procedure StopExistingService();
var
  ResultCode: Integer;
  ServicePath: String;
begin
  ServicePath := ExpandConstant('{app}\{#ServiceExecutable}');
  if not FileExists(ServicePath) then
    Exit;

  Exec(ServicePath, 'stop', ExpandConstant('{app}'), SW_HIDE,
    ewWaitUntilTerminated, ResultCode);
  Exec(ServicePath, 'uninstall', ExpandConstant('{app}'), SW_HIDE,
    ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopExistingService();
  Result := '';
end;

procedure WriteServiceConfig();
var
  Config: String;
  ConfigPath: String;
  LogsPath: String;
begin
  ConfigPath := ExpandConstant('{app}\{#ServiceBaseName}.xml');
  LogsPath := ExpandConstant('{commonappdata}\Otzaria\HebrewBooksSearch\logs');
  ForceDirectories(LogsPath);

  Config :=
    '<service>' + #13#10 +
    '  <id>{#ServiceId}</id>' + #13#10 +
    '  <name>Otzaria HebrewBooks Search</name>' + #13#10 +
    '  <description>Local HebrewBooks search service for Otzaria</description>' + #13#10 +
    '  <executable>%BASE%\runtime\hbsearch.exe</executable>' + #13#10 +
    '  <arguments>--serve --port 8080 --data-root &quot;' +
      XmlEscape(GetDataRoot('')) + '&quot;</arguments>' + #13#10 +
    '  <workingdirectory>%BASE%\runtime</workingdirectory>' + #13#10 +
    '  <startmode>Automatic</startmode>' + #13#10 +
    '  <delayedAutoStart/>' + #13#10 +
    '  <logpath>' + XmlEscape(LogsPath) + '</logpath>' + #13#10 +
    '  <log mode="roll-by-size">' + #13#10 +
    '    <sizeThreshold>10240</sizeThreshold>' + #13#10 +
    '    <keepFiles>8</keepFiles>' + #13#10 +
    '  </log>' + #13#10 +
    '  <onfailure action="restart" delay="30 sec"/>' + #13#10 +
    '  <onfailure action="restart" delay="1 min"/>' + #13#10 +
    '  <resetfailure>1 hour</resetfailure>' + #13#10 +
    '  <stoptimeout>15 sec</stoptimeout>' + #13#10 +
    '</service>' + #13#10;

  if not SaveStringToFile(ConfigPath, Config, False) then
    RaiseException('לא ניתן ליצור את תצורת שירות החיפוש.');
end;

procedure InstallAndStartService();
var
  ResultCode: Integer;
  ServicePath: String;
begin
  WriteServiceConfig();
  ServicePath := ExpandConstant('{app}\{#ServiceExecutable}');

  if not Exec(ServicePath, 'install', ExpandConstant('{app}'), SW_HIDE,
      ewWaitUntilTerminated, ResultCode) then
    RaiseException('לא ניתן להפעיל את מתקין שירות החיפוש.');
  if ResultCode <> 0 then
    RaiseException('התקנת שירות החיפוש נכשלה.');

  if not Exec(ServicePath, 'start', ExpandConstant('{app}'), SW_HIDE,
      ewWaitUntilTerminated, ResultCode) then
  begin
    Exec(ServicePath, 'uninstall', ExpandConstant('{app}'), SW_HIDE,
      ewWaitUntilTerminated, ResultCode);
    RaiseException('לא ניתן להפעיל את שירות החיפוש.');
  end;
  if ResultCode <> 0 then
  begin
    Exec(ServicePath, 'uninstall', ExpandConstant('{app}'), SW_HIDE,
      ewWaitUntilTerminated, ResultCode);
    RaiseException('הפעלת שירות החיפוש נכשלה.');
  end;
end;
