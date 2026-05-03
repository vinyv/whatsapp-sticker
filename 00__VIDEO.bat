@echo off
setlocal enabledelayedexpansion
title YT-DLP 4K Downloader + Auto Fixer

:: Ensure the videos directory exists
if not exist "%~dp0videos" mkdir "%~dp0videos"

:: --- SETUP ---
set "temp_dl=temp_processing.mp4"
set "temp_fixed=temp_fixed.mp4"

:: Clean up old temp files if they exist to prevent errors
if exist "%temp_dl%" del "%temp_dl%"
if exist "%temp_fixed%" del "%temp_fixed%"

:: --- YOUTUBE CLIENT BYPASS ---
:: Forces yt-dlp to use the web_embedded client to bypass strict blocks.
set bypass_args=--extractor-args "youtube:player_client=default,web_embedded"

:: --- COOKIE CONFIGURATION ---
set "browser_name=firefox"
set "cookie_flags="
if exist "%~dp0cookies.txt" (
    echo [INFO] Found cookies.txt. Using it for authentication...
    set "cookie_flags=--cookies "%~dp0cookies.txt""
) else (
    echo [INFO] Attempting to use %browser_name% browser cookies...
    set "cookie_flags=--cookies-from-browser %browser_name%"
)
echo.

:: 0. Check for updates (Nightly channel)
echo ==================================================
echo      Checking for yt-dlp nightly updates...
echo ==================================================
.\yt-dlp.exe --update-to nightly
echo.

:: 1. GET LINK
echo ==================================================
echo      4K Downloader (Original Filename)
echo ==================================================
echo.
set /p "link=Paste the link here: "
echo.

:: 2. GET ORIGINAL FILENAME
echo [1/4] Fetching video title...
if not exist "yt-dlp.exe" (
    echo ERROR: yt-dlp.exe not found!
    pause
    exit /b
)

:: Get the base filename (Cookie and Bypass flags injected here)
for /f "delims=" %%i in ('yt-dlp.exe !cookie_flags! !bypass_args! --get-filename -o "%%(title)s.mp4" --no-warnings "%link%"') do set "original_name=%%i"

:: === NEW: Handle duplicate filenames by auto-incrementing ===
set "base_name=!original_name:~0,-4!"
set "final_name=!original_name!"
set "counter=1"

:check_dupe
:: Check if the file already exists inside the videos folder
if exist "%~dp0videos\!final_name!" (
    set "final_name=!base_name! (!counter!).mp4"
    set /a counter+=1
    goto check_dupe
)

echo Target Filename: "!final_name!"

:: 3. DOWNLOAD TO TEMP FILE
echo.
echo [2/4] Downloading...
:: FIX: Cookie and Bypass flags injected here for the actual download
.\yt-dlp.exe !cookie_flags! !bypass_args! -f "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best" --merge-output-format mp4 --no-playlist --no-warnings --force-overwrites -o "%temp_dl%" "%link%"

if not exist "%temp_dl%" (
    echo ERROR: Download failed. The video might not be embeddable.
    pause
    exit /b
)

:: 4. CHECK CODEC
echo.
echo [3/4] Checking Video Codec...
for /f "tokens=*" %%a in ('ffprobe -v error -select_streams v:0 -show_entries stream^=codec_name -of default^=noprint_wrappers^=1:nokey^=1 "%temp_dl%"') do set "codec=%%a"

echo Detected Codec: !codec!

:: 5. DECIDE & RENAME
if /i "!codec!"=="h264" (
    echo [OK] Video is already H.264.
    move /y "%temp_dl%" "%~dp0videos\!final_name!" >nul
) else (
    echo [!] Video is !codec!. Re-encoding to H.264...
    echo.

    ffmpeg -hwaccel cuda ^
      -i "%temp_dl%" ^
      -c:v h264_nvenc ^
      -preset p4 ^
      -rc vbr ^
      -cq 23 ^
      -profile:v high ^
      -c:a aac ^
      -b:a 192k ^
      -movflags +faststart ^
      -y "%temp_fixed%"

    :: Verify if ffmpeg succeeded
    if exist "%temp_fixed%" (
        del "%temp_dl%"
        move /y "%temp_fixed%" "%~dp0videos\!final_name!" >nul
    ) else (
        echo [ERROR] FFmpeg failed to convert the file.
        pause
        exit /b
    )
)

echo.
echo [4/4] Process Complete!
echo Saved as: "!final_name!" in the videos folder.
echo.
pause
