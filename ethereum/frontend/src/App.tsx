import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import CreateInvoice from './pages/CreateInvoice';
import InvoiceDetail from './pages/InvoiceDetail';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<CreateInvoice />} />
          <Route path="/invoice/:address" element={<InvoiceDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
