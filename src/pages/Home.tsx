import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Navbar } from '../components/Navbar';

export function HomePage() {
  return (
    <>
      <Navbar />
      <main>
        <section className="hero">
          <div className="hero-body">
            <div className="hero-copy">
              <h1>Cleaner Lakes<br />Healthier Tomorrow</h1>
              <p>Autonomous lake cleaning with real-time monitoring, smarter data, and a healthier environment.</p>
              <div className="hero-actions">
                <Link to="/telemetry" className="btn-primary">
                  Open Dashboard <ArrowRight size={15} />
                </Link>
                <Link to="/observatory" className="btn-glass">Learn More</Link>
              </div>
            </div>
          </div>
          <div className="hero-strip">
            <span><i className="rule" aria-hidden="true" />People<span>Technology</span><span>Cleaner Water</span></span>
            <span>RVCE SCRUB</span>
          </div>
        </section>
      </main>
    </>
  );
}
