# Сборка «Подбор кодов» через Nuitka (настоящая компиляция в C).
# У Nuitka в разы меньше ложных срабатываний антивируса, чем у PyInstaller/onefile.
# Результат — папка build-nuitka\crack_cell_gui.dist (onedir), её упаковывает installer.iss.
#
# Требуется: Python 3.10+, установленный C-компилятор (Nuitka сам предложит MinGW64).
#   pip install nuitka bleak "qrcode[pil]" pillow
# Запуск:  powershell -ExecutionPolicy Bypass -File build-nuitka.ps1

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$Version   = "1.3.0"
$Company   = "SHK Tools"
$Product   = "Подбор кодов"
$OutDir    = "build-nuitka"
$Icon      = "app.ico"

if (-not (Test-Path $Icon)) { throw "Нет файла иконки $Icon" }

Write-Host "== Nuitka build $Product $Version ==" -ForegroundColor Cyan

python -m nuitka `
    --standalone `
    --assume-yes-for-downloads `
    --enable-plugin=tk-inter `
    --windows-console-mode=disable `
    --include-package=bleak `
    --include-package=bleak_winrt `
    --include-package=qrcode `
    --include-package=PIL `
    --include-module=scan_hook `
    --include-module=niimbot_printer `
    --include-module=crack_cell `
    --windows-icon-from-ico=$Icon `
    --company-name=$Company `
    --product-name=$Product `
    --file-version=$Version `
    --product-version=$Version `
    --file-description=$Product `
    --output-dir=$OutDir `
    crack_cell_gui.py

if ($LASTEXITCODE -ne 0) { throw "Nuitka завершилась с ошибкой $LASTEXITCODE" }

$Dist = Join-Path $OutDir "crack_cell_gui.dist"
Write-Host "`nГотово. Папка сборки: $Dist" -ForegroundColor Green
Write-Host "Дальше: скомпилировать installer.iss через Inno Setup (ISCC.exe)." -ForegroundColor Green
