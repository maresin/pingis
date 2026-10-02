import si from 'systeminformation';

export interface ResourceInfo {
  diskFree: string;
  ramFree: string;
}

export async function probeResources(cwd: string): Promise<ResourceInfo> {
  const fs = await si.fsSize();
  const mem = await si.mem();

  const mount = fs
    .filter(f => cwd.startsWith(f.mount))
    .sort((a, b) => b.mount.length - a.mount.length)[0];

  return {
    diskFree: formatBytes(mount?.available ?? 0),
    ramFree: formatBytes(mem.available)
  };
}

function formatBytes(n: number): string {
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = n / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}
