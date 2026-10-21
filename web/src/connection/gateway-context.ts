// The commands components send to the gateway. main.tsx provides the page's
// GatewayClient once the viewer has joined (P1-16); until then, and in tests,
// the context is null and controls that need the gateway do nothing.
import { createContext, useContext } from 'react';

import type { GatewayClient } from './gateway-client.js';

export type GatewayCommands = Pick<
  GatewayClient,
  'placeOrder' | 'cancelOrder' | 'cancelAll' | 'setInterval'
>;

export const GatewayContext = createContext<GatewayCommands | null>(null);

export function useGateway(): GatewayCommands | null {
  return useContext(GatewayContext);
}
