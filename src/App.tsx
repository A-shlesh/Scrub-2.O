import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { LakeProvider } from './stores/lake';
import { TelemetryProvider } from './stores/telemetry';
import { ThemeProvider } from './stores/theme';
import { HomePage } from './pages/Home';
import { ObservatoryPage } from './pages/Observatory';
import { MissionPage } from './pages/Mission';
import { TelemetryPage } from './pages/Telemetry';
import { AnalyticsPage } from './pages/Analytics';
import { HistoryPage } from './pages/History';
import { DemoPage } from './pages/Demo';
import { AuthGate } from './components/AuthGate';

export default function App() {
  return (
    <ThemeProvider>
      <AuthGate>
      <TelemetryProvider>
        <LakeProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/observatory" element={<ObservatoryPage />} />
              <Route path="/mission" element={<MissionPage />} />
              <Route path="/telemetry" element={<TelemetryPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/demo" element={<DemoPage />} />
            </Routes>
          </BrowserRouter>
        </LakeProvider>
      </TelemetryProvider>
      </AuthGate>
    </ThemeProvider>
  );
}
