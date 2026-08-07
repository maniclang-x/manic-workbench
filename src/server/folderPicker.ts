import { spawn } from "node:child_process";
import { platform } from "node:os";

export async function pickFolder(currentFolder: string): Promise<string | null> {
  if (platform() === "darwin") {
    const script = [
      "set chosenFolder to choose folder with prompt \"Open a Manic project\" default location POSIX file " + appleScriptString(currentFolder),
      "return POSIX path of chosenFolder",
    ].join("\n");
    return runPicker("osascript", ["-e", script]);
  }

  if (platform() === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dialog.SelectedPath = '${currentFolder.replaceAll("'", "''")}'`,
      "$dialog.Description = 'Open a Manic project'",
      "if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }",
    ].join("; ");
    return runPicker("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  }

  const zenity = await runPicker("zenity", ["--file-selection", "--directory", "--title=Open a Manic project", `--filename=${currentFolder}/`], true);
  if (zenity !== null) return zenity;
  return runPicker("kdialog", ["--getexistingdirectory", currentFolder, "--title", "Open a Manic project"], true);
}

function appleScriptString(value: string): string {
  return `\"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}\"`;
}

function runPicker(command: string, arguments_: string[], missingIsCancel = false): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (missingIsCancel && error.code === "ENOENT") resolve(null);
      else reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) resolve(output.trim() || null);
      else if (code === 1) resolve(null);
      else reject(new Error(errorOutput.trim() || `${command} exited with status ${code}.`));
    });
  });
}
