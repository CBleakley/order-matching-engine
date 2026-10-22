import { AppHeader } from './components/AppHeader.js';
import { Panel } from './components/Panel.js';
import { PendingOrders } from './components/PendingOrders.js';
import { PositionCard } from './components/PositionCard.js';
import { PriceChart } from './components/PriceChart.js';
import { TradeHistory } from './components/TradeHistory.js';

// The dashboard layout from the design canvas. The remaining placeholder is
// replaced by the order ticket (P1-18).
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
              <div className="placeholder">The order ticket appears here.</div>
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
