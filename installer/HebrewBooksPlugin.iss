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
; runasoriginaluser קריטי כאן ולא רק נימוס: רישום הפרוטוקול `otzaria://` והתקנת
; אוצריא עצמה יושבים ב-HKCU וב-%LOCALAPPDATA% של המשתמש המחובר, ולא של החשבון
; המורם שמריץ את המתקין. waituntilterminated (במקום nowait) מאפשר ל-Inno לדווח
; אם powershell.exe עצמו לא ניתן להפעלה — הסקריפט מסיים מיד אחרי שיגור אוצריא.
Filename: "powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\installer\Install-OtzariaPlugin.ps1"" -PluginPath ""{app}\plugin\{#PluginArchive}"""; Description: "התקן את התוסף באוצריא"; Flags: postinstall runhidden waituntilterminated skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\{#ServiceExecutable}"; Parameters: "stop"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{app}\{#ServiceExecutable}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist

[UninstallDelete]
Type: files; Name: "{app}\{#ServiceBaseName}.xml"
Type: filesandordirs; Name: "{commonappdata}\Otzaria\HebrewBooksSearch\logs"
Type: dirifempty; Name: "{commonappdata}\Otzaria\HebrewBooksSearch"

[Code]
const
  SC_MANAGER_CONNECT = $0001;
  SERVICE_QUERY_STATUS = $0004;
  SERVICE_RUNNING = 4;
  HealthUrl = 'http://127.0.0.1:8080/health';
  HealthAttempts = 30;
  HealthBudgetMs = 40000;

type
  TServiceStatus = record
    ServiceType: Cardinal;
    CurrentState: Cardinal;
    ControlsAccepted: Cardinal;
    Win32ExitCode: Cardinal;
    ServiceSpecificExitCode: Cardinal;
    CheckPoint: Cardinal;
    WaitHint: Cardinal;
  end;

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
  Lines: TArrayOfString;
  ConfigPath: String;
  LogsPath: String;
begin
  ConfigPath := ExpandConstant('{app}\{#ServiceBaseName}.xml');
  LogsPath := ExpandConstant('{commonappdata}\Otzaria\HebrewBooksSearch\logs');
  ForceDirectories(LogsPath);

  SetArrayLength(Lines, 20);
  Lines[0] := '<?xml version="1.0" encoding="utf-8"?>';
  Lines[1] := '<service>';
  Lines[2] := '  <id>{#ServiceId}</id>';
  Lines[3] := '  <name>Otzaria HebrewBooks Search</name>';
  Lines[4] := '  <description>Local HebrewBooks search service for Otzaria</description>';
  Lines[5] := '  <executable>%BASE%\runtime\hbsearch.exe</executable>';
  // --listen is the service default too, but spelled out so the registration shows
  // that only this machine reaches search, snippets, PDFs and drive paths.
  Lines[6] := '  <arguments>--serve --listen 127.0.0.1 --port 8080 --data-root &quot;' +
    XmlEscape(GetDataRoot('')) + '&quot;</arguments>';
  Lines[7] := '  <workingdirectory>%BASE%\runtime</workingdirectory>';
  // הפעלה מיידית באתחול, בלי השהיה: חימום אינדקס בכונן USB הוא החלק האטי,
  // והוא נדחה ממילא מפני חיפוש אמיתי.
  Lines[8] := '  <startmode>Automatic</startmode>';
  Lines[9] := '  <logpath>' + XmlEscape(LogsPath) + '</logpath>';
  Lines[10] := '  <log mode="roll-by-size">';
  Lines[11] := '    <sizeThreshold>10240</sizeThreshold>';
  Lines[12] := '    <keepFiles>8</keepFiles>';
  Lines[13] := '  </log>';
  // כונן ה-USB עלול לא להיות מוכן באתחול; hbsearch מסיים אז בקוד 2. Windows שומר
  // שלוש פעולות כשל בלבד וחוזר על האחרונה, ולכן שלושתן נכתבות במפורש.
  Lines[14] := '  <onfailure action="restart" delay="30 sec"/>';
  Lines[15] := '  <onfailure action="restart" delay="1 min"/>';
  Lines[16] := '  <onfailure action="restart" delay="2 min"/>';
  Lines[17] := '  <resetfailure>1 hour</resetfailure>';
  Lines[18] := '  <stoptimeout>15 sec</stoptimeout>';
  Lines[19] := '</service>';

  // חובה UTF-8: WinSW קורא את הקובץ כ-UTF-8, בעוד SaveStringToFile כותב ב-ANSI
  // לפי ה-code page של המערכת. נתיב הנתונים מכיל את שם המשתמש, ולכן שם משתמש
  // בעברית (או כל תו לא-לטיני בנתיב שנבחר) הפיל את השירות עם
  // "Invalid character in the given encoding".
  if not SaveStringsToUTF8File(ConfigPath, Lines, False) then
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

// דרך ה-API ולא דרך `sc query`: פלט sc מתורגם לשפת המערכת, וקוד היציאה שלו זהה
// בכל מצב שירות.
function OpenSCManagerW(MachineName, DatabaseName: String; DesiredAccess: Cardinal): Cardinal;
  external 'OpenSCManagerW@advapi32.dll stdcall';
function OpenServiceW(Manager: Cardinal; ServiceName: String; DesiredAccess: Cardinal): Cardinal;
  external 'OpenServiceW@advapi32.dll stdcall';
function QueryServiceStatus(Service: Cardinal; var Status: TServiceStatus): Boolean;
  external 'QueryServiceStatus@advapi32.dll stdcall';
function CloseServiceHandle(Handle: Cardinal): Boolean;
  external 'CloseServiceHandle@advapi32.dll stdcall';
function GetTickCount(): Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';

function ServiceIsRunning(): Boolean;
var
  Manager: Cardinal;
  Service: Cardinal;
  Status: TServiceStatus;
begin
  Result := False;
  Manager := OpenSCManagerW('', 'ServicesActive', SC_MANAGER_CONNECT);
  if Manager = 0 then
    Exit;
  Service := OpenServiceW(Manager, '{#ServiceId}', SERVICE_QUERY_STATUS);
  if Service <> 0 then
  begin
    if QueryServiceStatus(Service, Status) then
      Result := Status.CurrentState = SERVICE_RUNNING;
    CloseServiceHandle(Service);
  end;
  CloseServiceHandle(Manager);
end;

function HealthBody(var Body: String): Boolean;
var
  Http: Variant;
begin
  Result := False;
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    // חייב זמן קצוב: פורט 8080 עלול להיות בידי תהליך שפותח חיבור ולא עונה.
    Http.SetTimeouts(2000, 2000, 2000, 4000);
    Http.Open('GET', HealthUrl, False);
    Http.Send('');
    if Http.Status = 200 then
    begin
      Body := Http.ResponseText;
      Result := True;
    end;
  except
    Result := False;
  end;
end;

function CompactJson(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, ' ', '', True);
  StringChangeEx(Result, #9, '', True);
  StringChangeEx(Result, #13, '', True);
  StringChangeEx(Result, #10, '', True);
end;

// כישלון כאן אינו מפיל את ההתקנה: כונן הנתונים עשוי פשוט להיות מנותק כרגע,
// והשירות ינסה לעלות שוב לבדו לפי פעולות הכשל שנרשמו לו.
procedure VerifyServiceHealth();
var
  Attempt: Integer;
  Started: Cardinal;
  Body: String;
  Reason: String;
begin
  Started := GetTickCount();
  Reason := 'שירות החיפוש לא הגיע למצב "פועל".';
  for Attempt := 1 to HealthAttempts do
  begin
    if ServiceIsRunning() then
    begin
      Reason := 'שירות החיפוש פועל, אך אינו עונה בכתובת ' + HealthUrl + '.';
      if HealthBody(Body) then
      begin
        Body := CompactJson(Body);
        // בלי זיהוי השירות, כל תהליך אחר שמחזיק את פורט 8080 ייראה כהצלחה.
        if Pos('"service":"hbsearch"', Body) = 0 then
          Reason := 'פורט 8080 תפוס בידי תוכנה אחרת, ולכן שירות החיפוש אינו זמין.'
        else if Pos('"searchable":true', Body) = 0 then
          Reason := 'השירות עלה אך לא הצליח לפתוח אף אינדקס בתיקיית הנתונים שנבחרה.'
        else
        begin
          Log('HebrewBooks: health check passed on attempt ' + IntToStr(Attempt) + '.');
          Exit;
        end;
      end;
    end;
    if GetTickCount() - Started >= HealthBudgetMs then
      Break;
    Sleep(1000);
  end;

  Log('HebrewBooks: health check failed. ' + Reason);
  if not WizardSilent then
    MsgBox(
      'ההתקנה הסתיימה, אך בדיקת שירות החיפוש נכשלה:' + #13#10 +
        Reason + #13#10#13#10 +
        'אם כונן הנתונים אינו מחובר כעת — חבר אותו, והשירות יעלה מעצמו תוך דקות ספורות.' + #13#10 +
        'אחרת אפשר לבדוק את יומן השירות בתיקייה:' + #13#10 +
        ExpandConstant('{commonappdata}\Otzaria\HebrewBooksSearch\logs'),
      mbInformation,
      MB_OK
    );
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    VerifyServiceHealth();
end;
