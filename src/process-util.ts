import { ChildProcess, spawn as nodeSpawn } from 'child_process';
import { isFunction, isNumber, isObject, regex } from '@tubular/util';

const isWindows = (process.platform === 'win32');

function unref(timer: any): any {
  if (timer?.unref)
    timer.unref();

  return timer;
}

export enum ErrorMode { DEFAULT, FAIL_ON_ANY_ERROR, IGNORE_ERRORS }
export type ErrorCheck = (s: string) => boolean;

export class ProcessError extends Error {
  constructor(msg: string, public code: number, public output: string) {
    super(msg);
  }
}

const MAX_MARK_TIME_DELAY = 100;
const NO_OP = (): void => {};

export function stripFormatting(s: string): string {
  return s?.replace(/\x1B\[[\d;]*[A-Za-z]/g, '');
}

function errorish(s: string): boolean {
  s = stripFormatting(s);

  return regex`\b(exception|operation not permitted|not a valid|
                  isn't a valid|Cannot resolve|must be specified|must implement|
                  need to install|doesn't exist|are required|should be strings?)\b${'i'}`.test(s) ||
         /[_\da-z](Error|Exception|Invalid)\b/.test(s) || /\[ERR_|code: 'ERR/.test(s);
}

export function spawn(command: string, args: string[], options?: any): ChildProcess;
export function spawn(command: string, uid?: number, args?: string[], options?: any): ChildProcess;
export function spawn(command: string, uidOrArgs?: string[] | number, optionsOrArgs?: any, options?: any): ChildProcess {
  let uid: number;
  let args: string[];

  if (isNumber(uidOrArgs)) {
    uid = uidOrArgs;
    args = optionsOrArgs || [];
  }
  else {
    args = uidOrArgs || [];
    options = optionsOrArgs;
    uid = options?.uid;
  }

  if (uid != null) {
    options = options ?? {};
    options.uid = uid;

    if (!options.env) {
      options.env = {};
      Object.assign(options.env, process.env);
    }
  }

  if (isWindows) {
    if (/^(chmod|chown|id)$/.test(command)) {
      // Effectively a "noop"
      command = 'rundll32';
      args = [];
    }
    else if (command === 'rm') {
      // Ad hoc, not a general solution conversion of rm!
      command = 'rmdir';
      args = ['/S', '/Q', args[1].replace(/\//g, '\\')];
    }
    else if (command === 'which')
      command = 'where';

    const cmd = process.env.comspec || 'cmd';

    if (options?.uid != null) {
      options = Object.assign({}, options);
      delete options.uid;
    }

    return nodeSpawn(cmd, ['/c', command, ...args], options);
  }
  else
    return nodeSpawn(command, args, options);
}

export function monitorProcess(proc: ChildProcess, markTime: (data?: string, stream?: number, done?: boolean) => void = undefined,
                               errorMode: ErrorMode | RegExp | ErrorCheck = ErrorMode.DEFAULT,
                               outputLimit = 0): Promise<string> {
  let errors = '';
  let output = '';

  return new Promise<string>((resolve, reject) => {
    const slowSpin = unref(setInterval(markTime || NO_OP, MAX_MARK_TIME_DELAY));

    const looksLikeAnError = (s: string): boolean => {
      if (isObject(errorMode))
        return (errorMode as RegExp).test(s);
      else if (isFunction(errorMode))
        return (errorMode as unknown as ErrorCheck)(s);
      else if (errorMode === ErrorMode.IGNORE_ERRORS)
        return false;
      else
        return errorish(s);
    };

    proc.stderr.on('data', data => {
      (markTime || NO_OP)(data?.toString() || '', 1);
      data = stripFormatting(data.toString());

      // If process is webpack, error checking gets confusing because a lot of non-error progress messaging goes to
      // stderr, and the webpack process doesn't exit with an error for compilation errors unless you make it do so.
      if (/(\[webpack.Progress])|Warning\b/.test(data))
        return;

      if (errorMode === ErrorMode.FAIL_ON_ANY_ERROR || looksLikeAnError(data)) {
        errors += data;

        if (outputLimit > 0 && errors.length > outputLimit)
          errors = errors.slice(-outputLimit);
      }
    });
    proc.stdout.on('data', data => {
      (markTime || NO_OP)(data?.toString() || '', 0);
      data = data.toString();
      output += data;

      if (outputLimit > 0 && output.length > outputLimit)
        output = output.slice(-outputLimit);

      if (looksLikeAnError(data)) {
        errors = errors ? errors + '\n' + data : data;

        if (outputLimit > 0 && errors.length > outputLimit)
          errors = errors.slice(-outputLimit);
      }
    });
    proc.on('error', err => {
      (markTime || NO_OP)(err.message, -1, true);

      if (errorMode === ErrorMode.IGNORE_ERRORS)
        resolve(output);
      else
        reject(err);
    });
    proc.on('exit', code => {
      (markTime || NO_OP)(code.toString(), code === 0 ? 0 : -1, true);
      clearInterval(slowSpin);

      if (code === 0 || errorMode === ErrorMode.IGNORE_ERRORS)
        resolve(output);
      else
        reject(new ProcessError(errors || code.toString(), code, output));
    });
  });
}
