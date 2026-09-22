; ============================================================
;  PLBT Trader Terminal - Inno Setup Installer Script
;  Устанавливает исходники приложения (React/Vite + Node + Python bridges)
;  и создаёт ярлыки, запускающие Launcher.bat
; ============================================================

#define MyAppName "PLBT Trader Terminal"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "PLBT"
#define MyAppExeName "Launcher.bat"
#define MyAppIconName "AppIcon.ico"

[Setup]
AppId={{8F2C1E4A-6B3D-4A2F-9C1E-3F7A2B5D9E01}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=PLBT_Trader_Terminal_Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppIconName}
SetupIconFile=AppIcon.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Все файлы проекта (положи их в подпапку AppFiles рядом с этим .iss,
; сохраняя структуру: src\, api\, public\ и т.д. — см. инструкцию ниже)
Source: "AppFiles\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; Лаунчер, который запускает сборку и сервер (лежит рядом с .iss файлом)
Source: "Launcher.bat"; DestDir: "{app}"; Flags: ignoreversion

; Иконка приложения (положи файл AppIcon.ico рядом с .iss, см. инструкцию)
Source: "AppIcon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppIconName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppIconName}"; Tasks: desktopicon
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить {#MyAppName}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;

  if not Exec('cmd.exe', '/c node -v', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    MsgBox('Node.js не найден в системе (команда "node -v" не сработала).' + #13#10 +
           'Установите Node.js (https://nodejs.org) перед первым запуском программы —' + #13#10 +
           'иначе автоматическая сборка и запуск сервера работать не будут.',
           mbInformation, MB_OK);
  end;

  if not Exec('cmd.exe', '/c python --version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    MsgBox('Python не найден в системе (команда "python --version" не сработала).' + #13#10 +
           'Установите Python 3 (https://python.org) перед первым запуском —' + #13#10 +
           'иначе модули календаря и COT-данных запускаться не будут.',
           mbInformation, MB_OK);
  end;
end;
