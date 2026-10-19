import { AppHeader } from './components/AppHeader.js';
import { Panel } from './components/Panel.js';

// The dashboard layout from the design canvas. Panels are placeholders until
// the chart (P1-17), order ticket (P1-18) and order/trade panels (P1-19) land.
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
              <div className="placeholder placeholder--chart">
                The candlestick chart appears here.
              </div>
            </Panel>
            <Panel title="Place order" className="panel--ticket">
              <div className="placeholder">The order ticket appears here.</div>
            </Panel>
          </div>
          <div className="row">
            <Panel title="Your pending orders" className="panel--table">
              <div className="placeholder">No pending orders.</div>
            </Panel>
            <Panel title="Your trade history" className="panel--table">
              <div className="placeholder">No fills yet.</div>
            </Panel>
          </div>
        </main>
      </div>
    </div>
  );
}
