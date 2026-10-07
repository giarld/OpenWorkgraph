/** Keep service-originated messages consistent with the Web UI terminology. */
export function displayTerminology(message: string): string {
  return message
    .replace(/\bRuntimes\b/g, 'Workspaces')
    .replace(/\bRuntime\b/g, 'Workspace')
    .replace(/(?<![\w/.-])runtimes(?![\w/-]|\.[\w])/g, 'workspaces')
    .replace(/(?<![\w/.-])runtime(?![\w/-]|\.[\w])/g, 'workspace')
    .replace(/运行时/g, '工作空间');
}
