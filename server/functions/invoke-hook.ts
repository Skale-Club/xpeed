// The server registers its function runner here at start-up. api/* handlers call it through this
// hook instead of importing the functions themselves, so they stay free of the Deno sources.
export type FunctionRunner = (name: string, request: Request, rest?: string) => Promise<Response>;

let runner: FunctionRunner | undefined;
export const setFunctionRunner = (next: FunctionRunner) => { runner = next; };
export const functionRunner = () => runner;
