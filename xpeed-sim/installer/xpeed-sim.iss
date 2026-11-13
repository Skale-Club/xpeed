; Installer of Xpeed Companion (Inno Setup 6). Built by installer\build.ps1, which also writes the icon this script needs.
; Installs for the current person only (no administrator), in %LOCALAPPDATA%\Programs\Xpeed Companion.
; What it sets up besides the files: the Start menu entry and (a choice, on by default) starting Xpeed Companion with
; Windows. An upgrade from the old name ("Xpeed Sim") removes the old folder, shortcuts, start-up entry and link scheme.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Xpeed Companion"
#define AppExe "xpeed-companion.exe"
#define AppIcon "xpeed-companion.ico"
; The name the program had before: only used to clean up what it left behind.
#define OldName "Xpeed Sim"
#define OldExe "xpeed-sim.exe"

[Setup]
; Never change this id: it is how an update finds the version it replaces.
AppId={{BFF666D4-D8B0-4201-BD7C-CE01BAD8FC31}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Xpeed
AppPublisherURL=https://xpeed.skale.club
AppSupportURL=https://xpeed.skale.club
DefaultDirName={localappdata}\Programs\{#AppName}
; An upgrade from the old folder ("Xpeed Sim") lands in the new one; the old folder is removed in [InstallDelete].
UsePreviousAppDir=no
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=xpeed-companion-setup-{#AppVersion}
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\{#AppIcon}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
; A running copy is asked to close (it holds the mutex below) and the new one is started after the install.
AppMutex=XpeedSimTray
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} setup

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "autostart"; Description: "{cm:AutoStartProgram,{#AppName}}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\target\release\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppIcon}"; DestDir: "{app}"; Flags: ignoreversion
; The licence of Chakra Petch, the font the panel's numbers are drawn in (carried inside the program).
Source: "..\assets\fonts\OFL.txt"; DestDir: "{app}"; DestName: "ChakraPetch-OFL.txt"; Flags: ignoreversion

[InstallDelete]
; The old install folder and the shortcuts of the old name, so an upgrade leaves exactly one copy and one Start menu entry.
; (Laps, the log and the connection live elsewhere; the program moves those itself the first time it starts.)
Type: filesandordirs; Name: "{localappdata}\Programs\{#OldName}"
Type: files; Name: "{autoprograms}\{#OldName}.lnk"
Type: files; Name: "{autodesktop}\{#OldName}.lnk"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "run"; IconFilename: "{app}\{#AppIcon}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "run"; IconFilename: "{app}\{#AppIcon}"; Tasks: desktopicon

[Registry]
; The old link scheme (xpeedsim:) is gone: the connection no longer uses one. Removed if an old install left it.
Root: HKCU; Subkey: "Software\Classes\xpeedsim"; ValueType: none; Flags: deletekey
; Start with Windows. If the old entry ("Xpeed Sim") is there, the person had it on: carry that to the new name first (this
; line is read before the old entry is deleted), then delete the old one. The program does the same at start-up (win.rs).
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"" run"; Check: OldStartupEntryExists; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "{#OldName}"; Flags: deletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"" run"; Tasks: autostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "run"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Make sure it is not running while its files are removed. (Laps, the log and the connection are left alone.)
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#AppExe}"; Flags: runhidden; RunOnceId: "StopXpeedCompanion"

[Code]
// True when the old start-up entry is there: the person had the program starting with Windows.
function OldStartupEntryExists: Boolean;
begin
  Result := RegValueExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', '{#OldName}');
end;

// A copy of the old program (xpeed-sim.exe) may still be running and would keep its files locked. The mutex and
// CloseApplications ask it to close; this makes sure, before any file is replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM {#OldExe}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
