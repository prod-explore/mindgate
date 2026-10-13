Set objFSO = CreateObject("Scripting.FileSystemObject")
strPath = objFSO.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = strPath
' The hub is written in TypeScript: build first, then start (secrets come from .env in this folder)
WshShell.Run "cmd /c npm run build && npm start", 0, False
Set WshShell = Nothing
