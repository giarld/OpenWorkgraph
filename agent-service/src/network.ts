import { networkInterfaces } from 'node:os';
import { BlockList, isIP, type AddressInfo } from 'node:net';

const privateNetworkAddresses = new BlockList();
privateNetworkAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
privateNetworkAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
privateNetworkAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
privateNetworkAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
privateNetworkAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
privateNetworkAddresses.addSubnet('fc00::', 7, 'ipv6');
privateNetworkAddresses.addSubnet('fe80::', 10, 'ipv6');
privateNetworkAddresses.addAddress('::1', 'ipv6');

/** HTTP is allowed only for literal private/link-local addresses and localhost. */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host.toLowerCase() === 'localhost') return true;
  const family = isIP(host);
  return family === 4 ? privateNetworkAddresses.check(host, 'ipv4') : family === 6 ? privateNetworkAddresses.check(host, 'ipv6') : false;
}

export interface ListenerInfo { serviceId: string; instanceId: string; localEndpoint: string; endpoints: string[] }
function url(host: string, port: number): string { return `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`; }
export function listenerInfo(address: AddressInfo, serviceId: string, instanceId: string): ListenerInfo {
  let hosts: string[];
  if (address.address === '0.0.0.0' || address.address === '::') {
    const ipv6 = address.address === '::';
    hosts = [ipv6 ? '::1' : '127.0.0.1'];
    for (const entries of Object.values(networkInterfaces())) {
      for (const item of entries ?? []) if (!item.internal && !item.address.includes('%') && (item.family === 'IPv4' || ipv6) && !item.address.startsWith('fe80:')) hosts.push(item.address);
    }
  } else hosts = [address.address];
  const endpoints = [...new Set(hosts)].map(host => url(host,address.port));
  return { serviceId,instanceId,localEndpoint:endpoints[0]!,endpoints };
}
export function acceptsHost(header: string | undefined, _address: AddressInfo): boolean {
  if (!header) return false;
  try {
    const parsed = new URL('http://' + header);
    return parsed.host.toLowerCase() === header.toLowerCase() && parsed.pathname === '/' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
