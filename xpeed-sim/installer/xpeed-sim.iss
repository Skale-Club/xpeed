; Installer of Xpeed Companion (Inno Setup 6). Built by installer\build.ps1, which also writes the icon this script needs.
; Installs for the current person only (no administrator), in %LOCALAPPDATA%\Programs\Xpeed Sim.
; What it sets up besides the files: the Start menu entry, the xpeedsim: link the Xpeed site opens to connect this
; computer, and (a choice, on by default) starting Xpeed Companion with Windows.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Xpeed Companion"
; The folder name and the autostart value name keep the product's old name, so an upgrade lands in the same folder
; and does not leave a second autostart entry. Display names use AppName.
#define AppDirName "Xpeed Sim"
#define AppExe "xpeed-sim.exe"

[Setup]
; Never change this id: it is how an update finds the version it replaces.
AppId={{BFF666D4-D8B0-4201-BD7C-CE01BAD8FC31}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Xpeed
AppPublisherURL=https://xpeed.skale.club
AppSupportURL=https://xpeed.skale.club
DefaultDirName={autopf}\{#AppDirName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=xpeed-sim-setup-{#AppVersion}
SetupIconFile=xpeed-sim.ico
UninstallDisplayIcon={app}\xpeed-sim.ico
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
Source: "xpeed-sim.ico"; DestDir: "{app}"; Flags: ignoreversion
; The licence of Chakra Petch, the font the panel's numbers are drawn in (carried inside the program).
Source: "..\assets\fonts\OFL.txt"; DestDir: "{app}"; DestName: "ChakraPetch-OFL.txt"; Flags: ignoreversion

[InstallDelete]
; Shortcuts of the old name, so an upgrade leaves exactly one Start menu entry.
Type: files; Name: "{autoprograms}\Xpeed Sim.lnk"
Type: files; Name: "{autodesktop}\Xpeed Sim.lnk"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "run"; IconFilename: "{app}\xpeed-sim.ico"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Parameters: "run"; IconFilename: "{app}\xpeed-sim.ico"; Tasks: desktopicon

[Registry]
; The link the Xpeed site opens to connect this computer. Windows hands it to `xpeed-sim.exe link "<link>"`, which asks first.
Root: HKCU; Subkey: "Software\Classes\xpeedsim"; ValueType: string; ValueName: ""; ValueData: "URL:Xpeed Companion"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\xpeedsim"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\xpeedsim\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\xpeed-sim.ico"
Root: HKCU; Subkey: "Software\Classes\xpeedsim\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" link ""%1"""
; Start with Windows, under the same (old, kept on purpose) value name the program's own menu switch uses (win.rs RUN_NAME).
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppDirName}"; ValueData: """{app}\{#AppExe}"" run"; Tasks: autostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "run"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Make sure it is not running while its files are removed. (Laps, the log and the connection are left alone.)
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#AppExe}"; Flags: runhidden; RunOnceId: "StopXpeedSim"
