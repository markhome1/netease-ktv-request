@echo off
title KTV 点歌服务
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js 18+
    pause
    exit /b 1
)

if not exist node_modules (
    echo [初始化] 首次运行，正在安装依赖...
    npm install
    if %errorlevel% neq 0 (
        echo [错误] npm install 失败
        pause
        exit /b 1
    )
)

echo ============================================
echo   KTV 点歌服务已启动
echo   管理后台: http://localhost:8080/admin
echo   按 Ctrl+C 停止服务
echo ============================================
node server.js
pause
