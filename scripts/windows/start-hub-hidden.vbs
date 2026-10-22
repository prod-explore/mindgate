Set objFSO = CreateObject("Scripting.FileSystemObject")
' The script lives in scripts\windows; the hub is in <repository>\gate
strPath = objFSO.BuildPath(objFSO.GetParentFolderName(objFSO.GetParentFolderName(objFSO.GetParentFolderName(WScript.ScriptFullName))), "gate")
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = strPath
' The hub is written in TypeScript: build first, then start (secrets come from .env in this folder)
WshShell.Run "cmd /c npm run build && npm start", 0, False
Set WshShell = Nothing
