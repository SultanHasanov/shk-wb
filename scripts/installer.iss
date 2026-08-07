; Установщик «Подбор кодов» для Inno Setup (бесплатный: https://jrsoftware.org/isinfo.php)
; Ставит программу в Program Files как обычное приложение: ярлыки, деинсталлятор,
; запись в «Установка и удаление программ». Это резко снижает подозрительность
; для антивируса по сравнению с «голым» onefile-exe.
;
; Перед компиляцией: собрать приложение через build-nuitka.ps1 (папка
; build-nuitka\crack_cell_gui.dist).
; Компиляция: открыть этот файл в Inno Setup и нажать Compile, либо
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss

#define MyAppName "Подбор кодов"
#define MyAppVersion "1.3.0"
#define MyAppPublisher "SHK Tools"
#define MyAppExeName "crack_cell_gui.exe"
; Папка сборки. PyInstaller onedir: "dist\Подбор кодов".
; Для Nuitka заменить на "build-nuitka\crack_cell_gui.dist".
#define MyDistDir "dist\Подбор кодов"

[Setup]
; Уникальный AppId — не менять между версиями (иначе будут дубликаты в списке программ).
AppId={{9F1C4B2E-6A3D-4E51-9C7A-2B8E5D4F1A30}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=dist-installer
OutputBaseFilename=Подбор кодов setup {#MyAppVersion}
SetupIconFile=app.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Ставим в профиль пользователя без прав администратора (меньше UAC-трений).
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
; Вся папка сборки Nuitka целиком.
Source: "{#MyDistDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Удалить {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
