@echo off
echo 正在停止 KTV 点歌服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8080 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>nul
)
echo 服务已停止。
timeout /t 2 >nul
