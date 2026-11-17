# Modern Explorer-style "Select folder" dialog (IFileOpenDialog + FOS_PICKFOLDERS).
# Prints the chosen path (UTF-8) or nothing when cancelled.
param([string]$Title = 'Select a project folder')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
public class FileOpenDialogCoClass {}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
  void BindToHandler();
  void GetParent();
  void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  void GetAttributes();
  void Compare();
}

[ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileOpenDialog {
  [PreserveSig] int Show(IntPtr parent);
  void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
  void SetOptions(uint fos);
  void GetOptions(out uint fos);
  void SetDefaultFolder(); void SetFolder(); void GetFolder(); void GetCurrentSelection();
  void SetFileName(); void GetFileName();
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
  void SetOkButtonLabel(); void SetFileNameLabel();
  void GetResult(out IShellItem item);
}

public static class FolderPicker {
  public static string Pick(IntPtr owner, string title) {
    var dlg = (IFileOpenDialog)new FileOpenDialogCoClass();
    uint opts; dlg.GetOptions(out opts);
    dlg.SetOptions(opts | 0x20 /*PICKFOLDERS*/ | 0x40 /*FORCEFILESYSTEM*/);
    dlg.SetTitle(title);
    if (dlg.Show(owner) != 0) return null;
    IShellItem item; dlg.GetResult(out item);
    string path; item.GetDisplayName(0x80058000 /*SIGDN_FILESYSPATH*/, out path);
    return path;
  }
}
'@

[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Invisible top-most owner. When the server runs hidden, Windows applies "hidden" to the FIRST window a
# child process shows — this throwaway owner absorbs that, so the real dialog appears in front.
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.TopMost = $true
$owner.Show()
$owner.Show()
$owner.Activate()

try {
  $path = [FolderPicker]::Pick($owner.Handle, $Title)
} catch {
  $fb = New-Object System.Windows.Forms.FolderBrowserDialog
  $fb.Description = $Title
  $path = if ($fb.ShowDialog($owner) -eq 'OK') { $fb.SelectedPath } else { $null }
}
$owner.Close()
if ($path) { Write-Output $path }
