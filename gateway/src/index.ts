// Placeholder. The gateway server arrives in P1-07; importing @ome/shared here
// proves workspace resolution and build order.
import { SHARED_PACKAGE } from '@ome/shared';

export const GATEWAY_PACKAGE = '@ome/gateway';
export const GATEWAY_DEPENDENCIES = [SHARED_PACKAGE] as const;
