' Starts the DSH desk window without a console window.
' Path is resolved relative to this script so the plugin folder can move.

Option Explicit

Dim fso, shell, base, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(base, "desk-window.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "desk-window.ps1 not found: " & ps1, 16, "DSH Desk"
  WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """"
shell.Run cmd, 0, False
