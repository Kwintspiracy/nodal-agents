// channels/log.ts — dev/test channel; logs via console.warn (only allowed console)

export interface LogSendOpts {
  text: string;
  jobId: string;
}

export function sendLog(opts: LogSendOpts): { messageId: string } {
  // console.warn is the only allowed console call in this codebase
  console.warn(`[delivery:log] job=${opts.jobId}`, opts.text);
  return { messageId: `log-${Date.now()}` };
}
