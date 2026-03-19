Set objShell = CreateObject("WScript.Shell")
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
objShell.CurrentDirectory = strPath
objShell.Run "cmd /c node server.js > data\server.log 2>&1", 0, False
WScript.Sleep 2000
objShell.Run "http://localhost:8080/admin", 0, False
