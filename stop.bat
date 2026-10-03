@echo off

rem  停掉游戏用的两个服务：Web（5178）和摄像头（5179）

rem  不会动 Ollama —— 那个留着跑，下次启动快



echo.

echo   停止拾物奇谭的服务 ...

echo.



set KILLED=0



for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:5178" ^| findstr LISTENING') do (

  echo   停 Web 服务     PID %%p

  taskkill /PID %%p /F >nul 2>&1

  set KILLED=1

)



for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:5179" ^| findstr LISTENING') do (

  echo   停 摄像头服务   PID %%p

  taskkill /PID %%p /F >nul 2>&1

  set KILLED=1

)



if "%KILLED%"=="0" (

  echo   两个服务都没在跑，没什么可停的

) else (

  echo.

  echo   已停止。Ollama 保留着没动。

)



echo.

pause

