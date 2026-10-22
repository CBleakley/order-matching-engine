import { AppHeader } from './components/AppHeader.js';
import { OrderTicket } from './components/OrderTicket.js';
import { Panel } from './components/Panel.js';
import { PendingOrders } from './components/PendingOrders.js';
import { PositionCard } from './components/PositionCard.js';
import { PriceChart } from './components/PriceChart.js';
import { TradeHistory } from './components/TradeHistory.js';

// The dashboard layout from the design canvas.
export function App() {
  return (
    <div className="page">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <div className="shell">
        <AppHeader />
        <main id="main" className="main" tabIndex={-1}>
          <div className="row">
            <Panel title="Price chart" className="panel--chart" hideHeading>
              <PriceChart />
            </Panel>
            <Panel title="Place order" className="panel--ticket">
              <OrderTicket />
              <PositionCard />
            </Panel>
          </div>
          <div className="row">
            <PendingOrders />
            <TradeHistory />
          </div>
        </main>
      </div>
    </div>
  );
}
