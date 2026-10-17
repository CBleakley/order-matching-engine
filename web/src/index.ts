// Placeholder. The React front end arrives in P1-14; importing @ome/shared here
// proves workspace resolution and build order.
import { SHARED_PACKAGE } from '@ome/shared';

export const WEB_PACKAGE = '@ome/web';
export const WEB_DEPENDENCIES = [SHARED_PACKAGE] as const;
