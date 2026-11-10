-- Generated from platform/db/src/seed-data/instrument-catalogue.ts
-- by platform/db/src/seed-data/generate-instrument-catalogue-seed-migration.ts.
-- Do not hand-edit — edit the source list and regenerate instead.
--
-- Seeds `instrument` with the checked-in sample catalogue (IR-21,
-- DD33/DD34/DD35): widely-held
-- European and US large capitalisations, compiled 2026-08-22. A static sample
-- catalogue, not any index's membership, with per-row first-party evidence
-- recorded in the source list.
--
-- Every row is `kind = SHARE`, `primary_identifier = ISIN`, `quote_policy =
-- AUTO`. `owner_tenant_id` is omitted (=> NULL => shared catalogue, D-17), and
-- so are `sector_code`, `industry_label` and `figi`: a company's identifier and
-- country of incorporation are facts from primary sources and may ship, another
-- party's classification output may not (FR-17, AC-21), and `figi` stays
-- unwritten (NG10).
--
-- The conflict clause is deliberately **bare** (DD34). Both unique keys on this
-- table are partial, so naming them for inference would restate their
-- predicates here and duplicate index definitions into a seed; a bare clause
-- covers the primary key and both partial keys at once and makes this migration
-- safely re-runnable against a database that already has these rows.
--
-- This file writes one table and nothing else: no backfill state row, no queue
-- job, no provider call. That is what makes the catalogue's backfill lazy
-- structurally rather than by intention (FR-21, AC-22) — a seeded row nobody
-- holds is invisible to every ingestion lane, which all fan out from held
-- positions. The single-target property is asserted by the regeneration drift
-- test, not just stated here.
INSERT INTO "instrument" ("id", "kind", "display_name", "listing_currency", "exchange_mic", "isin", "symbol", "primary_identifier", "quote_policy", "domicile_country") VALUES
  ('01a02b21-eb98-7333-b4b0-8dc6be3a2fac', 'SHARE', 'TotalEnergies', 'EUR', 'XPAR', 'FR0000120271', 'TTE', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eb99-791f-893d-6020fe136416', 'SHARE', 'LVMH Moët Hennessy Louis Vuitton', 'EUR', 'XPAR', 'FR0000121014', 'MC', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eb9a-7b5b-92a5-6828e979da02', 'SHARE', 'Sanofi', 'EUR', 'XPAR', 'FR0000120578', 'SAN', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eb9b-7c09-aa43-df04bfa6d0b8', 'SHARE', 'Airbus', 'EUR', 'XPAR', 'NL0000235190', 'AIR', 'ISIN', 'AUTO', 'NL'),
  ('01a02b21-eb9c-7752-a884-719d130930d5', 'SHARE', 'Schneider Electric', 'EUR', 'XPAR', 'FR0000121972', 'SU', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eb9d-7796-86cf-70df25276621', 'SHARE', 'Air Liquide', 'EUR', 'XPAR', 'FR0000120073', 'AI', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eb9e-7313-9223-24a9eda451c1', 'SHARE', 'Hermès International', 'EUR', 'XPAR', 'FR0000052292', 'RMS', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eb9f-75bc-a9d1-c8dc35804dd5', 'SHARE', 'EssilorLuxottica', 'EUR', 'XPAR', 'FR0000121667', 'EL', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba0-72ce-b2d1-9595ca41f6ed', 'SHARE', 'Safran', 'EUR', 'XPAR', 'FR0000073272', 'SAF', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba1-7425-8a96-01f00233679c', 'SHARE', 'BNP Paribas', 'EUR', 'XPAR', 'FR0000131104', 'BNP', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba2-78ba-942a-589f6b079ae0', 'SHARE', 'AXA', 'EUR', 'XPAR', 'FR0000120628', 'CS', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba3-7f50-9c70-a0cea619c7b5', 'SHARE', 'Vinci', 'EUR', 'XPAR', 'FR0000125486', 'DG', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba4-7dd2-8cb4-8ba33a914dae', 'SHARE', 'Danone', 'EUR', 'XPAR', 'FR0000120644', 'BN', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba5-7348-aad5-81afd4f0514d', 'SHARE', 'Kering', 'EUR', 'XPAR', 'FR0000121485', 'KER', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba6-7bdd-adc6-2b5f1ad9e1fc', 'SHARE', 'Pernod Ricard', 'EUR', 'XPAR', 'FR0000120693', 'RI', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba7-7263-96ce-e30739494a44', 'SHARE', 'Compagnie de Saint-Gobain', 'EUR', 'XPAR', 'FR0000125007', 'SGO', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba8-785f-a786-4027b7177ae4', 'SHARE', 'Dassault Systèmes', 'EUR', 'XPAR', 'FR0014003TT8', 'DSY', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-eba9-7db0-92de-698eb974774c', 'SHARE', 'Michelin (CGDE)', 'EUR', 'XPAR', 'FR001400AJ45', 'ML', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebaa-764e-be74-bb13dbac0f55', 'SHARE', 'Capgemini', 'EUR', 'XPAR', 'FR0000125338', 'CAP', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebab-7c7c-aa3a-f80e429f0e1e', 'SHARE', 'L''Oréal', 'EUR', 'XPAR', 'FR0000120321', 'OR', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebac-7ca3-b6fb-36d009111a55', 'SHARE', 'Orange', 'EUR', 'XPAR', 'FR0000133308', 'ORA', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebad-7144-ae0f-d7c334a54421', 'SHARE', 'Legrand', 'EUR', 'XPAR', 'FR0010307819', 'LR', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebae-7f25-a1e8-96c64c0f750c', 'SHARE', 'Publicis Groupe', 'EUR', 'XPAR', 'FR0000130577', 'PUB', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebaf-7728-b613-303d95588e3d', 'SHARE', 'Thales', 'EUR', 'XPAR', 'FR0000121329', 'HO', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebb0-772d-8574-e676eadf86d2', 'SHARE', 'Crédit Agricole', 'EUR', 'XPAR', 'FR0000045072', 'ACA', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebb1-7119-a9f4-c1ebc6a7cffa', 'SHARE', 'Société Générale', 'EUR', 'XPAR', 'FR0000130809', 'GLE', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebb2-773b-989d-0914260af46d', 'SHARE', 'Veolia Environnement', 'EUR', 'XPAR', 'FR0000124141', 'VIE', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebb3-704e-90cd-32d726805fdf', 'SHARE', 'Engie', 'EUR', 'XPAR', 'FR0010208488', 'ENGI', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebb4-752f-8f13-3663b9fbb9cb', 'SHARE', 'Renault', 'EUR', 'XPAR', 'FR0000131906', 'RNO', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebb5-7d5f-ad72-8344a1df072f', 'SHARE', 'Stellantis', 'EUR', 'XPAR', 'NL00150001Q9', 'STLAP', 'ISIN', 'AUTO', 'NL'),
  ('01a02b21-ebb6-73ac-b67e-037c0b76a81c', 'SHARE', 'Bouygues', 'EUR', 'XPAR', 'FR0000120503', 'EN', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebb7-7ea6-bba0-5ef190022417', 'SHARE', 'Carrefour', 'EUR', 'XPAR', 'FR0000120172', 'CA', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebb8-7743-ba54-c79025953101', 'SHARE', 'Accor', 'EUR', 'XPAR', 'FR0000120404', 'AC', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebb9-7ede-9f54-17e3e57aba3a', 'SHARE', 'Eurofins Scientific', 'EUR', 'XPAR', 'FR0014000MR3', 'ERF', 'ISIN', 'AUTO', 'LU'),
  ('01a02b21-ebba-7353-b79a-c97ddfa6e94c', 'SHARE', 'Edenred', 'EUR', 'XPAR', 'FR0010908533', 'EDEN', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebbb-76c3-8777-611bac71ce7e', 'SHARE', 'Bureau Veritas', 'EUR', 'XPAR', 'FR0006174348', 'BVI', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebbc-783c-9fb4-c8fe9753f0f2', 'SHARE', 'Alstom', 'EUR', 'XPAR', 'FR0010220475', 'ALO', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebbd-7686-b3fe-3b44c625f11f', 'SHARE', 'Arkema', 'EUR', 'XPAR', 'FR0010313833', 'AKE', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebbe-7c7d-b9c5-28a14853753a', 'SHARE', 'Worldline', 'EUR', 'XPAR', 'FR00140182K6', 'WLN', 'ISIN', 'AUTO', 'FR'),
  ('01a02b21-ebbf-7680-a815-d0ac94b6008d', 'SHARE', 'ArcelorMittal', 'EUR', 'XAMS', 'LU1598757687', 'MT', 'ISIN', 'AUTO', 'LU'),
  ('01a02b21-ebc0-7b2a-b3d1-b2c09d10640c', 'SHARE', 'Apple Inc.', 'USD', 'XNAS', 'US0378331005', 'AAPL', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebc1-7e5d-b9d3-443e4e93c00a', 'SHARE', 'Microsoft Corp.', 'USD', 'XNAS', 'US5949181045', 'MSFT', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebc2-7fab-8353-af27475394fa', 'SHARE', 'NVIDIA Corp.', 'USD', 'XNAS', 'US67066G1040', 'NVDA', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebc3-726e-8777-9c4ddacffc0d', 'SHARE', 'Amazon.com Inc.', 'USD', 'XNAS', 'US0231351067', 'AMZN', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebc4-7897-838d-19fed4b5a4e2', 'SHARE', 'Alphabet Inc. Cl A', 'USD', 'XNAS', 'US02079K3059', 'GOOGL', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebc5-732e-b39f-6a0f68560d9e', 'SHARE', 'Alphabet Inc. Cl C', 'USD', 'XNAS', 'US02079K1079', 'GOOG', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebc6-7374-9a33-2fde388f9d56', 'SHARE', 'Meta Platforms Inc. Class A', 'USD', 'XNAS', 'US30303M1027', 'META', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebc7-7f02-b8e1-2e72cf99db09', 'SHARE', 'Broadcom Inc.', 'USD', 'XNAS', 'US11135F1012', 'AVGO', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebc8-7c67-a4a6-efed3ec9682b', 'SHARE', 'Visa Inc. Class A Shares', 'USD', 'XNYS', 'US92826C8394', 'V', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebc9-7eff-9857-39ae33a8c3e4', 'SHARE', 'JPMorgan Chase & Co.', 'USD', 'XNYS', 'US46625H1005', 'JPM', 'ISIN', 'AUTO', 'US'),
  ('01a02b21-ebca-7684-b224-9e1af83aa9f9', 'SHARE', 'Eli Lilly & Co.', 'USD', 'XNYS', 'US5324571083', 'LLY', 'ISIN', 'AUTO', 'US')
ON CONFLICT DO NOTHING;
