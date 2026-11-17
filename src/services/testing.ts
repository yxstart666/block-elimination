/** Test-only access does not write completion records or change release unlock rules. */
export function isBrowserTestUnlock(hostname: unknown, search: string): boolean {
  return (hostname === 'localhost' || hostname === '127.0.0.1') && new URLSearchParams(search).get('unlock') === 'all';
}

/** Local previews skip advertising and coin charges unless exercising real flows. */
export function isBrowserTestConvenience(hostname: unknown, search: string): boolean {
  return (hostname === 'localhost' || hostname === '127.0.0.1') && new URLSearchParams(search).get('test') !== 'off';
}

export function isWechatTestUnlock(wxApi: any): boolean {
  try {
    const version = wxApi?.getAccountInfoSync?.()?.miniProgram?.envVersion;
    return version === 'develop' || version === 'trial';
  } catch { return false; }
}
