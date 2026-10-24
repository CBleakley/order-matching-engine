// Fails the run at once, with instructions, if a part of the stack is not built.
import { checkBuilt } from './stack.ts';

export default function globalSetup(): void {
  checkBuilt();
}
