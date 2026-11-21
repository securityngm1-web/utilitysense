// Monthly Electricity & Solar Bill Variance Comparison System
// Single unified comparison table: Exactly TWO categories (Electricity and Solar)
// Compact Layout, Popup Modal Upload with Location/Plant/Month selector, Fixed Table Header & Compact KPI Bar

import React, { useState, useMemo, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { extractTextFromPdfBuffer, parseMsedclBillText } from '../../utils/msedclBillParser';
import { saveBillFile, getBillFile, clearAllBillFiles } from '../../utils/billStorage';
import BillPreviewModal from './BillPreviewModal';


function fmtUnits(val, unit = 'kWh') {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return Number(val).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' ' + unit;
}

function fmtINR(val, decimals = 2) {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return '₹ ' + Number(val).toLocaleString('en-IN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

function fmtVariance(diff, unit = '', isFinancial = false, baseVal = null) {
    if (diff === null || diff === undefined || isNaN(diff)) return '—';
    const num = Number(diff);
    if (num === 0) return isFinancial ? '₹ 0.00 (100% Match)' : `0 ${unit} (100% Match)`;

    const sign = num > 0 ? '+' : '−';
    const absNum = Math.abs(num);
    const base = Number(baseVal);
    const pct = base && !isNaN(base) && base > 0 ? ((absNum / base) * 100).toFixed(2) : null;
    const pctStr = pct !== null ? ` (${num > 0 ? '+' : '−'}${pct}%)` : '';
    const label = num > 0 ? 'Software Higher' : 'Software Lower';

    if (isFinancial) {
        const valStr = '₹ ' + absNum.toLocaleString('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
        return `${sign}${valStr}${pctStr} · ${label}`;
    }
    return `${sign}${absNum.toLocaleString('en-IN', { maximumFractionDigits: 0 })} ${unit}${pctStr} · ${label}`;
}

export default function ReconciliationModule({
    plants = [],
    dailyEntries = [],
    tariffs = [],
    currentUser,
    supabase,
    onRefreshTariffs
}) {
    // 0. Active Sub-Tab Navigation
    const [activeSubTab, setActiveSubTab] = useState('variance'); // 'variance' | 'tariff_progression'

    // 1. Location Selection
    const locations = useMemo(() => {
        const set = new Set();
        plants.forEach((p) => {
            if (p.location) set.add(String(p.location).trim().toUpperCase());
        });
        return Array.from(set).sort();
    }, [plants]);

    const [selectedLocation, setSelectedLocation] = useState('PUNE');

    // 2. Plant Selection (Filtered by location)
    const filteredPlants = useMemo(() => {
        if (!selectedLocation || selectedLocation === 'ALL') return plants;
        return plants.filter((p) => String(p.location || '').toUpperCase() === selectedLocation);
    }, [plants, selectedLocation]);

    const [selectedPlantCode, setSelectedPlantCode] = useState('4010');

    const selectedPlant = useMemo(() => {
        return (
            filteredPlants.find((p) => String(p.plant_code).trim().toLowerCase() === String(selectedPlantCode).trim().toLowerCase()) ||
            filteredPlants[0] ||
            plants[0] || { plant_code: '4010', plant_display_name: 'NGM', location: 'PUNE' }
        );
    }, [filteredPlants, plants, selectedPlantCode]);

    // 3. Month & Year Selection (Jan to Dec chronological order)
    const [selectedMonth, setSelectedMonth] = useState('2026-05');

    const availableMonths = useMemo(() => {
        const set = new Set();
        (dailyEntries || []).forEach(e => {
            if (e.date && e.date.length >= 7) {
                set.add(e.date.substring(0, 7));
            }
        });
        // 2026 calendar months Jan to Dec
        ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'].forEach(m => set.add(m));
        return Array.from(set).sort(); // Jan to Dec chronological order
    }, [dailyEntries]);

    // 4. Stored bills dictionary: keyed by `plantCode_month`
    // Zero preloaded data so user can upload and test fresh from scratch
    const [savedBills, setSavedBills] = useState(() => {
        try {
            // Remove all legacy mock/cached storage keys
            [
                'ep_monthly_variance_bills',
                'ep_monthly_variance_bills_v1',
                'ep_monthly_variance_bills_v2',
                'ep_monthly_variance_bills_v3',
                'ep_monthly_variance_bills_v4',
                'ep_monthly_variance_bills_v5',
                'ep_utility_bills_v1',
                'ep_reconciliation_clarifications_v1'
            ].forEach(k => {
                localStorage.removeItem(k);
            });
            const stored = localStorage.getItem('ep_monthly_variance_bills_v6');
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (e) {
            console.error('Failed to load saved bills:', e);
        }
        return {};
    });

    const persistBills = (newDict) => {
        setSavedBills(newDict);
        try {
            localStorage.setItem('ep_monthly_variance_bills_v6', JSON.stringify(newDict));
        } catch (e) {
            console.error('Failed to save bills:', e);
        }
    };

    const handleClearAllBills = async () => {
        if (window.confirm('Are you sure you want to clear all uploaded bills? You can re-upload them anytime.')) {
            persistBills({});
            setActiveBillFileUrl(null);
            [
                'ep_monthly_variance_bills',
                'ep_monthly_variance_bills_v1',
                'ep_monthly_variance_bills_v2',
                'ep_monthly_variance_bills_v3',
                'ep_monthly_variance_bills_v4',
                'ep_monthly_variance_bills_v5',
                'ep_monthly_variance_bills_v6',
                'ep_utility_bills_v1',
                'ep_reconciliation_clarifications_v1'
            ].forEach(k => {
                localStorage.removeItem(k);
            });
            await clearAllBillFiles();
            setUploadSuccess('All bills cleared. You can now upload fresh bills from scratch!');
        }
    };

    const currentKey = `${selectedPlant?.plant_code || selectedPlantCode}_${selectedMonth}`;
    const activeBill = savedBills[currentKey] || null;

    // 5. In-App Document Preview State (IndexedDB integration)
    const [activeBillFileUrl, setActiveBillFileUrl] = useState(null);
    const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);

    useEffect(() => {
        let isMounted = true;
        getBillFile(currentKey).then((record) => {
            if (isMounted) {
                if (record && record.url) {
                    setActiveBillFileUrl(record.url);
                } else {
                    setActiveBillFileUrl(null);
                }
            }
        });
        return () => { isMounted = false; };
    }, [currentKey]);

    // 6. User Allow / Deny Decisions for Tariff Revisions (Persisted in localStorage)
    const [tariffDecisions, setTariffDecisions] = useState(() => {
        try {
            const stored = localStorage.getItem('ep_tariff_decisions_v1');
            return stored ? JSON.parse(stored) : {};
        } catch (e) {
            return {};
        }
    });

    const saveTariffDecision = (key, decision) => {
        const next = { ...tariffDecisions, [key]: decision };
        setTariffDecisions(next);
        try {
            localStorage.setItem('ep_tariff_decisions_v1', JSON.stringify(next));
        } catch (e) {
            console.error('Failed to save tariff decision:', e);
        }
    };

    // Modal state for confirming "ALLOW & APPLY TARIFF"
    const [isAllowModalOpen, setIsAllowModalOpen] = useState(false);
    const [recalculateNextEntries, setRecalculateNextEntries] = useState(true);
    const [isApplyingTariff, setIsApplyingTariff] = useState(false);

    // 7. Upload Bill Popup Modal State (Allows selecting Location, Plant, Month & File inside popup)
    const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
    const [uploadModalLocation, setUploadModalLocation] = useState(selectedLocation);
    const [uploadModalPlantCode, setUploadModalPlantCode] = useState(selectedPlantCode);
    const [uploadModalMonth, setUploadModalMonth] = useState(selectedMonth);
    const [uploadModalFile, setUploadModalFile] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const modalFileInputRef = useRef(null);

    const handleOpenUploadModal = () => {
        setUploadModalLocation(selectedLocation);
        setUploadModalPlantCode(selectedPlantCode);
        setUploadModalMonth(selectedMonth);
        setUploadModalFile(null);
        setUploadError('');
        setIsUploadModalOpen(true);
    };

    // Upload & Extract State
    const [isExtracting, setIsExtracting] = useState(false);
    const [uploadError, setUploadError] = useState('');
    const [uploadSuccess, setUploadSuccess] = useState('');

    // 8. Fetch Corresponding Month's Actual Software Data from Database
    const systemData = useMemo(() => {
        const plantCode = String(selectedPlant?.plant_code || selectedPlantCode).trim().toUpperCase();
        const plantName = String(selectedPlant?.plant_display_name || '').trim().toUpperCase();

        const matched = (dailyEntries || [])
            .filter((e) => {
                if (!e.date || !e.date.startsWith(selectedMonth)) return false;
                const p = String(e.plant || '').trim().toUpperCase();
                return p === plantCode || (plantName && p === plantName);
            })
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        let totalElectricityKwh = 0;
        let totalSolarGenKwh = 0;

        matched.forEach((e) => {
            totalElectricityKwh += Number(e.electricity_consumption) || 0;
            totalSolarGenKwh += Number(e.solar_generated) || 0;
        });

        const getElOpen = (entry) => {
            if (!entry) return null;
            if (entry.electricity_opening !== undefined && entry.electricity_opening !== null && entry.electricity_opening !== '') {
                return Number(entry.electricity_opening);
            }
            if (entry.electricity_meters?.[0]?.opening !== undefined && entry.electricity_meters?.[0]?.opening !== null) {
                return Number(entry.electricity_meters[0].opening);
            }
            return null;
        };

        const getElClose = (entry) => {
            if (!entry) return null;
            if (entry.electricity_closing !== undefined && entry.electricity_closing !== null && entry.electricity_closing !== '') {
                return Number(entry.electricity_closing);
            }
            if (entry.electricity_meters?.[0]?.closing !== undefined && entry.electricity_meters?.[0]?.closing !== null) {
                return Number(entry.electricity_meters[0].closing);
            }
            return null;
        };

        const getSolOpen = (entry) => {
            if (!entry) return null;
            if (entry.solar_opening !== undefined && entry.solar_opening !== null && entry.solar_opening !== '') {
                return Number(entry.solar_opening);
            }
            if (entry.solar_meters?.[0]?.opening !== undefined && entry.solar_meters?.[0]?.opening !== null) {
                return Number(entry.solar_meters[0].opening);
            }
            return null;
        };

        const getSolClose = (entry) => {
            if (!entry) return null;
            if (entry.solar_closing !== undefined && entry.solar_closing !== null && entry.solar_closing !== '') {
                return Number(entry.solar_closing);
            }
            if (entry.solar_meters?.[0]?.closing !== undefined && entry.solar_meters?.[0]?.closing !== null) {
                return Number(entry.solar_meters[0].closing);
            }
            return null;
        };

        const first = matched[0] || null;
        const last = matched[matched.length - 1] || null;

        return {
            daysRecorded: matched.length,
            electricityKwh: totalElectricityKwh,
            solarGenKwh: totalSolarGenKwh,
            electricityOpening: getElOpen(first),
            electricityClosing: getElClose(last),
            solarOpening: getSolOpen(first),
            solarClosing: getSolClose(last)
        };
    }, [dailyEntries, selectedPlant, selectedPlantCode, selectedMonth]);

    // 9. Resolve Applicable Software Baseline Tariff Rate
    const baselineSoftwareTariff = useMemo(() => {
        const plantCode = String(selectedPlant?.plant_code || selectedPlantCode).trim().toLowerCase();
        const loc = String(selectedPlant?.location || 'PUNE').trim().toUpperCase();
        const monthRefDate = `${selectedMonth}-28`;

        const candidates = (tariffs || []).filter((t) =>
            t.type === 'electricity' &&
            t.status === 'Active' &&
            String(t.effective_date || '') <= monthRefDate
        );

        const score = (t) => {
            const tPlant = String(t.plant_code || '').trim().toLowerCase();
            const tLoc = String(t.location || '').trim().toUpperCase();
            if (tPlant && tPlant === plantCode) return 3;
            if (tLoc && tLoc === loc && !tPlant) return 2;
            if (!tLoc && !tPlant) return 1;
            return 0;
        };

        const best = candidates
            .map((t) => ({ t, s: score(t) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s || String(b.t.effective_date).localeCompare(String(a.t.effective_date)));

        if (best.length) return Number(best[0].t.rate);
        return 8.44; // Default MSEDCL HT industrial tariff
    }, [tariffs, selectedPlant, selectedPlantCode, selectedMonth]);

    const activeEnergyTariff = useMemo(() => {
        if (activeBill?.energyTariffRate && activeBill.energyTariffRate > 0) {
            return Number(activeBill.energyTariffRate);
        }
        return baselineSoftwareTariff;
    }, [activeBill, baselineSoftwareTariff]);

    const activeGridSupportTariff = useMemo(() => {
        if (activeBill?.gridSupportTariffRate && activeBill.gridSupportTariffRate > 0) {
            return Number(activeBill.gridSupportTariffRate);
        }
        return 1.42; // Standard MSEDCL MERC solar parallel operation fee
    }, [activeBill]);

    // 10. Next Month and Rate Revision Calculation
    const nextMonthInfo = useMemo(() => {
        if (!selectedMonth) return { key: '', firstDate: '', label: '' };
        const [y, m] = selectedMonth.split('-').map(Number);
        const nextD = new Date(y, m, 1);
        const ny = nextD.getFullYear();
        const nm = String(nextD.getMonth() + 1).padStart(2, '0');
        const key = `${ny}-${nm}`;
        const firstDate = `${ny}-${nm}-01`;
        const label = nextD.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        return { key, firstDate, label };
    }, [selectedMonth]);

    const billEnergyRate = activeBill?.energyTariffRate ? Number(activeBill.energyTariffRate) : null;
    const rateDiff = (billEnergyRate !== null && baselineSoftwareTariff !== null)
        ? Number((billEnergyRate - baselineSoftwareTariff).toFixed(2))
        : null;
    const hasRateRevision = Boolean(billEnergyRate !== null && rateDiff !== null && Math.abs(rateDiff) >= 0.01);
    const currentDecision = tariffDecisions[currentKey] || null;

    // 11. Handlers for ALLOW and DENY Tariff Revision
    const handleDenyTariffRevision = () => {
        saveTariffDecision(currentKey, {
            status: 'DENIED',
            retainedRate: baselineSoftwareTariff,
            billRate: billEnergyRate,
            timestamp: new Date().toISOString()
        });
        setUploadSuccess(`Decision recorded: Retained existing baseline rate of ₹${baselineSoftwareTariff.toFixed(2)}/unit.`);
    };

    const handleConfirmAllowTariff = async () => {
        if (!billEnergyRate) return;
        setIsApplyingTariff(true);

        try {
            const plantCode = String(selectedPlant?.plant_code || selectedPlantCode);
            const location = selectedPlant?.location || 'PUNE';
            const effectiveDate = nextMonthInfo.firstDate;
            const tariffId = `tariff_${plantCode}_elect_${nextMonthInfo.key.replace('-', '')}`;

            // 1. Insert new tariff into Supabase if connected
            if (supabase) {
                const { error: tariffErr } = await supabase.from('tariffs').upsert({
                    tariff_id: tariffId,
                    location,
                    plant_code: plantCode,
                    type: 'electricity',
                    rate: billEnergyRate,
                    effective_date: effectiveDate,
                    status: 'Active'
                });

                if (tariffErr) {
                    console.warn('Could not insert tariff into Supabase (will persist locally):', tariffErr);
                }

                // 2. If requested, recalculate next month's existing entries
                if (recalculateNextEntries) {
                    const { data: nextEntries } = await supabase.from('daily_entries')
                        .select('id, electricity_consumption, solar_generated, diesel_cost, lpg_cost')
                        .eq('plant', plantCode)
                        .gte('date', effectiveDate);

                    if (nextEntries && nextEntries.length > 0) {
                        for (const row of nextEntries) {
                            const elCost = (Number(row.electricity_consumption) || 0) * billEnergyRate;
                            const solCost = (Number(row.solar_generated) || 0) * billEnergyRate;
                            const totCost = elCost + solCost + (Number(row.diesel_cost) || 0) + (Number(row.lpg_cost) || 0);

                            await supabase.from('daily_entries').update({
                                electricity_cost: Math.round(elCost * 100) / 100,
                                solar_cost: Math.round(solCost * 100) / 100,
                                total_cost: Math.round(totCost * 100) / 100
                            }).eq('id', row.id);
                        }
                    }
                }

                if (onRefreshTariffs) {
                    onRefreshTariffs();
                }
            }

            // 3. Save decision locally
            saveTariffDecision(currentKey, {
                status: 'ALLOWED',
                appliedRate: billEnergyRate,
                effectiveDate,
                effectiveMonth: nextMonthInfo.key,
                timestamp: new Date().toISOString()
            });

            setIsAllowModalOpen(false);
            setUploadSuccess(`Rate ₹${billEnergyRate.toFixed(2)}/unit applied for subsequent calculations starting ${nextMonthInfo.label}!`);
        } catch (err) {
            console.error('Error applying tariff:', err);
            setUploadError('Failed to apply tariff update. Please check database permissions.');
        } finally {
            setIsApplyingTariff(false);
        }
    };

    // 12. Combined Bill Upload Handler (Can receive custom plant and month from popup modal)
    const handleBillUpload = async (file, customPlantCode = null, customMonth = null) => {
        if (!file) return;
        setIsExtracting(true);
        setUploadError('');
        setUploadSuccess('');

        const targetPlant = customPlantCode || selectedPlantCode;
        const targetMonth = customMonth || selectedMonth;

        try {
            const fileName = file.name;
            const isPdf = fileName.toLowerCase().endsWith('.pdf');
            const isExcel = fileName.toLowerCase().endsWith('.xlsx') || fileName.toLowerCase().endsWith('.xls');

            if (isPdf) {
                const arrayBuffer = await file.arrayBuffer();
                const rawText = await extractTextFromPdfBuffer(arrayBuffer);
                if (!rawText || rawText.trim().length < 20) {
                    throw new Error('Unable to extract digital text from this PDF. Please verify the document.');
                }

                const parsed = parseMsedclBillText(rawText);
                if (!parsed) {
                    throw new Error('Could not identify electricity and solar parameters from this bill.');
                }

                const detectedMonth = parsed.billMonth || targetMonth;
                const targetKey = `${targetPlant}_${detectedMonth}`;

                const newBill = {
                    id: `uploaded_${Date.now()}`,
                    fileName,
                    uploadedAt: new Date().toISOString(),
                    billMonth: detectedMonth,
                    consumerNo: parsed.consumerNo || '',
                    consumerName: parsed.consumerName || '',
                    meterNo: parsed.meterNo || '',
                    // Page 2: Consumption Details
                    openingMeter: parsed.openingMeter !== undefined ? parsed.openingMeter : null,
                    closingMeter: parsed.closingMeter !== undefined ? parsed.closingMeter : null,
                    meterDifference: parsed.meterDifference !== undefined ? parsed.meterDifference : null,
                    multiplyingFactor: parsed.multiplyingFactor || 1,
                    billedUnitsKwh: parsed.billedUnitsKwh,
                    billedUnitsKvah: parsed.billedUnitsKvah,
                    grossUnitsKwh: parsed.grossUnitsKwh,
                    solarExportUnits: parsed.solarExportUnits || parsed.solarAdjUnits || 0,
                    // Page 3: Debit Details
                    totalCurrentBill: parsed.currentBillAmount || parsed.totalBillAmount,
                    energyCharges: parsed.energyCharges,
                    energyTariffRate: parsed.energyTariffRate || 8.44,
                    gridSupportCharges: parsed.gridSupportCharges,
                    gridSupportTariffRate: parsed.gridSupportTariffRate || 1.42,
                    // Page 6: TOD Solar Generation Meter Details
                    solarGenOpening: parsed.solarGenOpening,
                    solarGenClosing: parsed.solarGenClosing,
                    solarGenDiff: parsed.solarGenDiff,
                    solarGenMf: parsed.solarGenMf || 4.0,
                    solarGenUnits: parsed.solarGenUnits
                };

                const updatedDict = {
                    ...savedBills,
                    [targetKey]: newBill
                };

                if (detectedMonth !== selectedMonth) {
                    setSelectedMonth(detectedMonth);
                }
                if (targetPlant !== selectedPlantCode) {
                    setSelectedPlantCode(targetPlant);
                }

                // Save PDF into IndexedDB for persistent in-app viewing
                await saveBillFile(targetKey, file, fileName);
                const localUrl = URL.createObjectURL(file);
                setActiveBillFileUrl(localUrl);

                persistBills(updatedDict);
                setUploadSuccess(`Electricity & Solar bill for ${detectedMonth} uploaded & extracted successfully!`);
            } else if (isExcel) {
                const arrayBuffer = await file.arrayBuffer();
                const wb = XLSX.read(arrayBuffer, { type: 'array' });
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
                const map = {};
                rows.forEach((r) => {
                    if (r[0] && r[1] !== undefined) map[String(r[0]).trim().toLowerCase()] = r[1];
                });

                const parsedMonth = map['bill month'] || map['month'] || targetMonth;
                const targetKey = `${targetPlant}_${parsedMonth}`;

                const newBill = {
                    id: `uploaded_xlsx_${Date.now()}`,
                    fileName,
                    uploadedAt: new Date().toISOString(),
                    billMonth: parsedMonth,
                    consumerNo: map['consumer no'] || '',
                    openingMeter: Number(map['opening meter'] || map['past reading'] || map['opening reading'] || map['previous reading']) || null,
                    closingMeter: Number(map['closing meter'] || map['current reading'] || map['present reading']) || null,
                    meterDifference: Number(map['meter difference'] || map['diff']) || null,
                    multiplyingFactor: Number(map['multiplying factor'] || map['mf']) || 1,
                    billedUnitsKwh: Number(map['billed kwh'] || map['kwh consumption']) || null,
                    billedUnitsKvah: Number(map['billed kvah'] || map['kvah consumption']) || null,
                    grossUnitsKwh: Number(map['gross kwh']) || null,
                    solarExportUnits: Number(map['solar export units'] || map['export credit']) || 0,
                    totalCurrentBill: Number(map['total current bill'] || map['bill amount']) || null,
                    energyCharges: Number(map['energy charges']) || null,
                    energyTariffRate: Number(map['tariff rate'] || map['energy rate']) || 8.44,
                    gridSupportCharges: Number(map['grid support charges']) || null,
                    gridSupportTariffRate: Number(map['grid support rate']) || 1.42,
                    solarGenOpening: Number(map['solar opening'] || map['solar gen opening']) || null,
                    solarGenClosing: Number(map['solar closing'] || map['solar gen closing']) || null,
                    solarGenDiff: Number(map['solar diff']) || null,
                    solarGenMf: Number(map['solar mf']) || 4.0,
                    solarGenUnits: Number(map['solar generation units'] || map['solar kwh']) || null
                };

                const updatedDict = {
                    ...savedBills,
                    [targetKey]: newBill
                };

                if (parsedMonth !== selectedMonth) {
                    setSelectedMonth(parsedMonth);
                }
                if (targetPlant !== selectedPlantCode) {
                    setSelectedPlantCode(targetPlant);
                }

                persistBills(updatedDict);
                setUploadSuccess(`Bill values for ${parsedMonth} imported from Excel successfully!`);
            } else {
                throw new Error('Unsupported file format. Please upload PDF or Excel.');
            }
        } catch (err) {
            console.error('Bill upload parsing error:', err);
            setUploadError(err.message || 'Failed to extract bill parameters.');
        } finally {
            setIsExtracting(false);
            if (modalFileInputRef.current) modalFileInputRef.current.value = '';
        }
    };

    // 13. Values Preparation for Variance Calculations
    const b = activeBill;
    const s = systemData;

    // Electricity
    const billCurrentTotal = b?.totalCurrentBill ?? null;
    const billUnitsKwh = b?.billedUnitsKwh ?? null;
    const billUnitsKvah = b?.billedUnitsKvah ?? null;
    const solarExportUnits = Number(b?.solarExportUnits) || 0;

    // When no bill is uploaded, do NOT show software or variance values in the audit table
    const sysGrossKwh = (activeBill && s.electricityKwh > 0) ? s.electricityKwh : null;
    const sysNetKwh = (activeBill && sysGrossKwh !== null) ? Math.max(0, sysGrossKwh - solarExportUnits) : null;
    const varUnitsKwh = (activeBill && sysNetKwh !== null && billUnitsKwh !== null) ? (sysNetKwh - billUnitsKwh) : null;

    const sysUnitsKvah = (activeBill && sysNetKwh !== null) ? sysNetKwh : null;
    const varUnitsKvah = (activeBill && sysUnitsKvah !== null && billUnitsKvah !== null) ? (sysUnitsKvah - billUnitsKvah) : null;

    const billEnergyCharges = b?.energyCharges || (billUnitsKvah ? billUnitsKvah * activeEnergyTariff : (billUnitsKwh ? billUnitsKwh * activeEnergyTariff : null));
    const sysEnergyCost = (activeBill && sysNetKwh !== null) ? (sysNetKwh * activeEnergyTariff) : null;
    const varEnergyCost = (activeBill && sysEnergyCost !== null && billEnergyCharges !== null) ? (sysEnergyCost - billEnergyCharges) : null;

    const billGridSupportCharges = (b && b.gridSupportCharges !== undefined && b.gridSupportCharges !== null)
        ? b.gridSupportCharges
        : (b && b.solarGenUnits ? b.solarGenUnits * activeGridSupportTariff : null);
    const sysGridSupportCost = (activeBill && s.solarGenKwh > 0) ? (s.solarGenKwh * activeGridSupportTariff) : null;
    const varGridSupportCost = (activeBill && sysGridSupportCost !== null && billGridSupportCharges !== null) ? (sysGridSupportCost - billGridSupportCharges) : null;

    // Solar
    const billSolarGenUnits = (b && b.solarGenUnits !== undefined && b.solarGenUnits !== null) ? b.solarGenUnits : null;
    const sysSolarGenUnits = (activeBill && s.solarGenKwh > 0) ? s.solarGenKwh : null;
    const varSolarGenUnits = (activeBill && sysSolarGenUnits !== null && billSolarGenUnits !== null) ? (sysSolarGenUnits - billSolarGenUnits) : null;

    // Period mismatch check
    const isPeriodMismatch = Boolean(b && b.billMonth && b.billMonth !== selectedMonth);

    // 14. Table Rows Configuration: Exactly TWO Categories (ELECTRICITY and SOLAR)
    const electricityRows = [
        {
            id: 'elect_tcb',
            particulars: 'Total Current Bill as per Tariff',
            detail: activeBill
                ? 'Page 3 MSEDCL Debit Table: Total Current Billed Amount (including Demand Charges, Wheeling Charges, Duty & Taxes)'
                : 'Page 3 MSEDCL Debit Table: Total Current Billed Amount',
            billVal: fmtINR(billCurrentTotal),
            sysVal: '—',
            variance: '—',
            rawVariance: null,
            isComparable: false,
            isFinancial: true
        },
        {
            id: 'elect_opening_rdg',
            particulars: 'Electricity Past Reading (Opening Meter)',
            detail: (activeBill && b?.openingMeter !== null && b?.openingMeter !== undefined)
                ? `Page 2 Reading Start: Previous Month Closing = Current Month Opening (${Number(b.openingMeter).toLocaleString('en-IN', { minimumFractionDigits: 2 })})`
                : 'Page 2 Initial/Opening Meter Reading',
            billVal: (activeBill && b?.openingMeter !== null && b?.openingMeter !== undefined) ? Number(b.openingMeter).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—',
            sysVal: (activeBill && s.electricityOpening !== null && s.electricityOpening !== undefined) ? Number(s.electricityOpening).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—',
            variance: (activeBill && s.electricityOpening !== null && b?.openingMeter !== null && b?.openingMeter !== undefined) ? fmtVariance(s.electricityOpening - b.openingMeter, '') : '—',
            rawVariance: (activeBill && s.electricityOpening !== null && b?.openingMeter !== null && b?.openingMeter !== undefined) ? s.electricityOpening - b.openingMeter : null,
            isComparable: Boolean(activeBill && s.electricityOpening !== null && b?.openingMeter !== null && b?.openingMeter !== undefined),
            isFinancial: false
        },
        {
            id: 'elect_closing_rdg',
            particulars: 'Electricity Current Reading (Closing Meter)',
            detail: (activeBill && b?.closingMeter !== null && b?.closingMeter !== undefined && b?.openingMeter !== null && b?.openingMeter !== undefined)
                ? `Page 2 Reading End: Meter Diff (${(b.closingMeter - b.openingMeter).toFixed(2)}) × MF ${b.multiplyingFactor || 40} = ${((b.closingMeter - b.openingMeter) * (b.multiplyingFactor || 40)).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Units`
                : 'Page 2 Final/Closing Meter Reading',
            billVal: (activeBill && b?.closingMeter !== null && b?.closingMeter !== undefined) ? Number(b.closingMeter).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—',
            sysVal: (activeBill && s.electricityClosing !== null && s.electricityClosing !== undefined) ? Number(s.electricityClosing).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—',
            variance: (activeBill && s.electricityClosing !== null && b?.closingMeter !== null && b?.closingMeter !== undefined) ? fmtVariance(s.electricityClosing - b.closingMeter, '') : '—',
            rawVariance: (activeBill && s.electricityClosing !== null && b?.closingMeter !== null && b?.closingMeter !== undefined) ? s.electricityClosing - b.closingMeter : null,
            isComparable: Boolean(activeBill && s.electricityClosing !== null && b?.closingMeter !== null && b?.closingMeter !== undefined),
            isFinancial: false
        },
        {
            id: 'elect_kvah',
            particulars: 'KVAH Electricity Consumption',
            detail: (activeBill && billUnitsKvah && billUnitsKwh)
                ? `Page 2 Billed kVAh (${billUnitsKvah?.toLocaleString()} kVAh at measured PF ${(billUnitsKwh / billUnitsKvah).toFixed(4)}) vs Software Net Equivalent (${sysUnitsKvah?.toLocaleString()} units)`
                : 'Page 2 Total Consumption KVAH vs Software Net Billed Units',
            billVal: fmtUnits(billUnitsKvah, 'kVAh'),
            sysVal: fmtUnits(sysUnitsKvah, 'units'),
            variance: fmtVariance(varUnitsKvah, 'units', false, billUnitsKvah),
            rawVariance: varUnitsKvah,
            isComparable: Boolean(activeBill && varUnitsKvah !== null),
            isFinancial: false
        },
        {
            id: 'elect_kwh',
            particulars: 'KWH Electricity Consumption',
            detail: (activeBill && solarExportUnits > 0)
                ? `MSEDCL Net Billed (${billUnitsKwh?.toLocaleString()} kWh) vs Software Net (Gross ${sysGrossKwh?.toLocaleString()} − Export Credit ${solarExportUnits?.toLocaleString()})`
                : 'Page 2 Total Consumption KWH vs Software Monthly KWH',
            billVal: fmtUnits(billUnitsKwh, 'kWh'),
            sysVal: fmtUnits(sysNetKwh, 'kWh'),
            variance: fmtVariance(varUnitsKwh, 'kWh', false, billUnitsKwh),
            rawVariance: varUnitsKwh,
            isComparable: Boolean(activeBill && varUnitsKwh !== null),
            isFinancial: false
        },
        {
            id: 'elect_energy_cost',
            particulars: 'Base Energy Charges (₹)',
            detail: activeBill
                ? `Formula: Software Net (${sysNetKwh?.toLocaleString()} kWh) × ₹${activeEnergyTariff.toFixed(2)} = ${fmtINR(sysEnergyCost)} vs Bill (${(billUnitsKvah || billUnitsKwh)?.toLocaleString()} units × ₹${activeEnergyTariff.toFixed(2)} = ${fmtINR(billEnergyCharges)}) | Diff: ${(varUnitsKvah || varUnitsKwh)?.toLocaleString()} × ₹${activeEnergyTariff.toFixed(2)} = ${fmtINR(varEnergyCost)}`
                : 'Base Energy Charges = Net Billed Units × Applicable Energy Tariff Rate',
            billVal: fmtINR(billEnergyCharges),
            sysVal: fmtINR(sysEnergyCost),
            variance: fmtVariance(varEnergyCost, '', true, billEnergyCharges),
            rawVariance: varEnergyCost,
            isComparable: Boolean(activeBill && varEnergyCost !== null),
            isHighlight: true,
            isFinancial: true
        },
        {
            id: 'elect_grid_support',
            particulars: 'Grid Support Charge (₹)',
            detail: activeBill
                ? `MERC Solar Parallel Fee (@ ₹${activeGridSupportTariff.toFixed(2)}/unit): Software Solar (${s.solarGenKwh?.toLocaleString()} units × ₹${activeGridSupportTariff.toFixed(2)} = ${fmtINR(sysGridSupportCost)}) vs Bill (${billSolarGenUnits?.toLocaleString()} units × ₹${activeGridSupportTariff.toFixed(2)} = ${fmtINR(billGridSupportCharges)}) | Diff: +${varSolarGenUnits} units × ₹${activeGridSupportTariff.toFixed(2)} = ${fmtINR(varGridSupportCost)}`
                : 'MERC Solar Parallel Fee (@ ₹1.42/unit) based on Solar Generation',
            billVal: fmtINR(billGridSupportCharges),
            sysVal: fmtINR(sysGridSupportCost),
            variance: fmtVariance(varGridSupportCost, '', true, billGridSupportCharges),
            rawVariance: varGridSupportCost,
            isComparable: Boolean(activeBill && varGridSupportCost !== null),
            isFinancial: true
        }
    ];

    const solarRows = [
        {
            id: 'solar_opening_rdg',
            particulars: 'Solar Gen Past Reading (Opening Meter)',
            detail: (activeBill && b?.solarGenOpening !== null && b?.solarGenOpening !== undefined)
                ? `Page 6 TOD Solar Meter: Previous Month Solar Closing = Current Month Opening (${Number(b.solarGenOpening).toLocaleString('en-IN', { minimumFractionDigits: 2 })})`
                : 'Page 6 TOD Solar Generation Opening Meter Reading',
            billVal: (activeBill && b?.solarGenOpening !== null && b?.solarGenOpening !== undefined) ? Number(b.solarGenOpening).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—',
            sysVal: (activeBill && s.solarOpening !== null && s.solarOpening !== undefined) ? Number(s.solarOpening).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—',
            variance: (activeBill && s.solarOpening !== null && b?.solarGenOpening !== null && b?.solarGenOpening !== undefined) ? fmtVariance(s.solarOpening - b.solarGenOpening, '') : '—',
            rawVariance: (activeBill && s.solarOpening !== null && b?.solarGenOpening !== null && b?.solarGenOpening !== undefined) ? s.solarOpening - b.solarGenOpening : null,
            isComparable: Boolean(activeBill && s.solarOpening !== null && b?.solarGenOpening !== null && b?.solarGenOpening !== undefined),
            isFinancial: false
        },
        {
            id: 'solar_closing_rdg',
            particulars: 'Solar Gen Current Reading (Closing Meter)',
            detail: (activeBill && b?.solarGenClosing !== null && b?.solarGenClosing !== undefined && b?.solarGenOpening !== null && b?.solarGenOpening !== undefined)
                ? `Page 6 TOD Solar Meter: Diff (${(b.solarGenClosing - b.solarGenOpening).toFixed(2)}) × MF ${b.solarGenMf || 4} = ${((b.solarGenClosing - b.solarGenOpening) * (b.solarGenMf || 4)).toLocaleString('en-IN', { maximumFractionDigits: 0 })} kWh`
                : 'Page 6 TOD Solar Generation Closing Meter Reading',
            billVal: (activeBill && b?.solarGenClosing !== null && b?.solarGenClosing !== undefined) ? Number(b.solarGenClosing).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—',
            sysVal: (activeBill && s.solarClosing !== null && s.solarClosing !== undefined) ? Number(s.solarClosing).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—',
            variance: (activeBill && s.solarClosing !== null && b?.solarGenClosing !== null && b?.solarGenClosing !== undefined) ? fmtVariance(s.solarClosing - b.solarGenClosing, '') : '—',
            rawVariance: (activeBill && s.solarClosing !== null && b?.solarGenClosing !== null && b?.solarGenClosing !== undefined) ? s.solarClosing - b.solarGenClosing : null,
            isComparable: Boolean(activeBill && s.solarClosing !== null && b?.solarGenClosing !== null && b?.solarGenClosing !== undefined),
            isFinancial: false
        },
        {
            id: 'solar_gen',
            particulars: 'Total Monthly Solar Generation (kWh)',
            detail: (activeBill && b?.solarGenOpening && b?.solarGenClosing)
                ? `Page 6 TOD Solar Meter: (${b.solarGenClosing.toLocaleString()} − ${b.solarGenOpening.toLocaleString()}) × MF ${b.solarGenMf || 4} = ${billSolarGenUnits?.toLocaleString()} kWh vs Software Daily Logs = ${sysSolarGenUnits?.toLocaleString()} kWh`
                : 'Page 6 TOD Solar Generation Meter (MF 4) vs Software Monthly Solar Gen',
            billVal: fmtUnits(billSolarGenUnits, 'kWh'),
            sysVal: fmtUnits(sysSolarGenUnits, 'kWh'),
            variance: fmtVariance(varSolarGenUnits, 'kWh', false, billSolarGenUnits),
            rawVariance: varSolarGenUnits,
            isComparable: Boolean(activeBill && varSolarGenUnits !== null),
            isHighlight: true,
            isFinancial: false
        }
    ];

    // Export Table to Excel handler
    const handleExportExcel = () => {
        const rows = [
            ...electricityRows.map(r => ({
                'Category': 'ELECTRICITY',
                'Particulars': r.particulars,
                'Description / Audit Formula': r.detail,
                'Actual Bill Value': r.billVal,
                'Software Monthly Value': r.sysVal,
                'Variance (Software − Bill)': r.variance
            })),
            ...solarRows.map(r => ({
                'Category': 'SOLAR',
                'Particulars': r.particulars,
                'Description / Audit Formula': r.detail,
                'Actual Bill Value': r.billVal,
                'Software Monthly Value': r.sysVal,
                'Variance (Software − Bill)': r.variance
            }))
        ];

        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Variance Comparison');
        XLSX.writeFile(wb, `Electricity_Solar_Variance_${selectedPlant?.plant_display_name || selectedPlantCode}_${selectedMonth}.xlsx`);
    };

    // 15. Tab 2: Tariff Progression & Audit Report Dataset
    const tariffProgressionData = useMemo(() => {
        const plantCode = String(selectedPlant?.plant_code || selectedPlantCode);
        return availableMonths.map((mKey) => {
            const key = `${plantCode}_${mKey}`;
            const billRecord = savedBills[key] || null;

            // Month date
            const [yr, mo] = mKey.split('-').map(Number);
            const dt = new Date(yr, mo - 1, 1);
            const monthLabel = dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

            // Rates
            const monthEndDate = `${mKey}-28`;
            const plantCodeLower = plantCode.toLowerCase();
            const locUpper = String(selectedPlant?.location || 'PUNE').toUpperCase();

            const candidates = (tariffs || []).filter(t =>
                t.type === 'electricity' &&
                t.status === 'Active' &&
                String(t.effective_date || '') <= monthEndDate
            );

            const score = (t) => {
                const tP = String(t.plant_code || '').toLowerCase();
                const tL = String(t.location || '').toUpperCase();
                if (tP && tP === plantCodeLower) return 3;
                if (tL && tL === locUpper && !tP) return 2;
                if (!tL && !tP) return 1;
                return 0;
            };

            const best = candidates.map(t => ({ t, s: score(t) })).filter(x => x.s > 0)
                .sort((a, b) => b.s - a.s || String(b.t.effective_date).localeCompare(String(a.t.effective_date)));

            const swRate = best.length ? Number(best[0].t.rate) : 8.44;
            const bRate = billRecord?.energyTariffRate ? Number(billRecord.energyTariffRate) : null;
            const diff = bRate !== null ? Number((bRate - swRate).toFixed(2)) : null;

            // Billed units
            const units = billRecord?.billedUnitsKvah || billRecord?.billedUnitsKwh || 0;
            const costImpact = (diff !== null && units > 0) ? Number((units * diff).toFixed(2)) : 0;

            const decision = tariffDecisions[key] || null;
            let status = 'NO_BILL';
            if (bRate !== null) {
                if (Math.abs(diff) < 0.01) status = 'MATCHED';
                else if (decision?.status === 'ALLOWED') status = 'ALLOWED';
                else if (decision?.status === 'DENIED') status = 'DENIED';
                else status = 'PENDING';
            }

            return {
                monthKey: mKey,
                monthLabel,
                hasBill: Boolean(billRecord),
                fileName: billRecord?.fileName || null,
                openingMeter: billRecord?.openingMeter ?? null,
                closingMeter: billRecord?.closingMeter ?? null,
                meterDifference: billRecord?.meterDifference ?? null,
                multiplyingFactor: billRecord?.multiplyingFactor ?? 40,
                solarGenOpening: billRecord?.solarGenOpening ?? null,
                solarGenClosing: billRecord?.solarGenClosing ?? null,
                solarGenUnits: billRecord?.solarGenUnits ?? null,
                billedUnits: units,
                softwareRate: swRate,
                billRate: bRate,
                rateDiff: diff,
                costImpact,
                status,
                decision,
                billRecord
            };
        });
    }, [availableMonths, selectedPlant, selectedPlantCode, savedBills, tariffs, tariffDecisions]);

    // Export Tariff Audit Report to Excel
    const handleExportTariffAuditExcel = () => {
        const rows = tariffProgressionData.map((r, idx) => ({
            'Sr. No.': idx + 1,
            'Billing Month': r.monthLabel,
            'Month Code': r.monthKey,
            'Elect Past Reading (Opening)': r.openingMeter !== null ? r.openingMeter : '—',
            'Elect Current Reading (Closing)': r.closingMeter !== null ? r.closingMeter : '—',
            'Solar Past Reading (Opening)': r.solarGenOpening !== null ? r.solarGenOpening : '—',
            'Solar Current Reading (Closing)': r.solarGenClosing !== null ? r.solarGenClosing : '—',
            'Billed Units (kVAh)': r.billedUnits || '—',
            'Software Baseline Rate (INR)': `₹ ${r.softwareRate.toFixed(2)}`,
            'MSEB Billed Rate (INR)': r.billRate ? `₹ ${r.billRate.toFixed(2)}` : 'No Bill Uploaded',
            'Rate Variance (INR)': r.rateDiff !== null ? `${r.rateDiff > 0 ? '+' : ''}${r.rateDiff.toFixed(2)}` : '—',
            'Financial Impact (INR)': r.costImpact ? `₹ ${r.costImpact.toLocaleString('en-IN')}` : '₹ 0.00',
            'Management Decision': r.status === 'ALLOWED' ? `ALLOWED (Applied next month)` : (r.status === 'DENIED' ? `DENIED (Retained ₹${r.decision?.retainedRate || r.softwareRate})` : (r.status === 'MATCHED' ? '100% MATCH' : (r.status === 'PENDING' ? 'PENDING APPROVAL' : 'No Bill'))),
            'Uploaded Bill File': r.fileName || 'Not uploaded'
        }));

        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [
            { wch: 8 }, { wch: 16 }, { wch: 12 }, { wch: 24 }, { wch: 24 }, { wch: 24 }, { wch: 24 }, { wch: 20 }, { wch: 26 }, { wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 30 }, { wch: 35 }
        ];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'MSEB_Tariff_Audit');
        XLSX.writeFile(wb, `MSEB_Tariff_Progression_Audit_${selectedPlant?.plant_display_name || selectedPlantCode}.xlsx`);
    };

    return (
        <div className="bg-slate-50 text-slate-800 px-3 py-1 font-sans w-full h-full max-h-full flex flex-col overflow-hidden max-w-[1600px] mx-auto">
            {/* IN-APP BILL PDF PREVIEW MODAL */}
            <BillPreviewModal
                isOpen={isPreviewModalOpen}
                onClose={() => setIsPreviewModalOpen(false)}
                billData={activeBill}
                fileUrl={activeBillFileUrl}
                plantName={selectedPlant?.plant_display_name || selectedPlantCode}
                monthLabel={selectedMonth}
            />

            {/* POPUP MODAL: UPLOAD BILL (LOCATION, PLANT, MONTH & FILE SELECTION) */}
            {isUploadModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/75 backdrop-blur-xs animate-in fade-in duration-150">
                    <div className="bg-white dark:bg-[#151f32] rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg overflow-hidden">
                        {/* Modal Header */}
                        <div className="px-5 py-3.5 bg-blue-600 text-white flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <span className="material-symbols-outlined text-[22px]">upload_file</span>
                                <h3 className="text-sm sm:text-base font-bold">Upload Electricity & Solar Bill</h3>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsUploadModalOpen(false)}
                                className="text-white/80 hover:text-white transition bg-transparent border-none cursor-pointer"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        {/* Modal Body: Location, Plant, Month & File */}
                        <div className="p-5 space-y-4 text-xs">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                {/* Location */}
                                <div>
                                    <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Location</label>
                                    <select
                                        value={uploadModalLocation}
                                        onChange={(e) => {
                                            setUploadModalLocation(e.target.value);
                                            const firstPlant = plants.find(p => String(p.location).toUpperCase() === e.target.value);
                                            if (firstPlant) setUploadModalPlantCode(firstPlant.plant_code);
                                        }}
                                        className="w-full h-8 bg-slate-50 border border-slate-300 rounded-lg px-2 text-xs font-semibold text-slate-800"
                                    >
                                        {locations.map(loc => <option key={loc} value={loc}>{loc}</option>)}
                                    </select>
                                </div>

                                {/* Plant */}
                                <div>
                                    <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Plant</label>
                                    <select
                                        value={uploadModalPlantCode}
                                        onChange={(e) => setUploadModalPlantCode(e.target.value)}
                                        className="w-full h-8 bg-slate-50 border border-slate-300 rounded-lg px-2 text-xs font-semibold text-slate-800"
                                    >
                                        {plants
                                            .filter(p => !uploadModalLocation || uploadModalLocation === 'ALL' || String(p.location).toUpperCase() === uploadModalLocation)
                                            .map(p => (
                                                <option key={p.plant_code} value={p.plant_code}>
                                                    {p.plant_display_name || p.plant_code}
                                                </option>
                                            ))
                                        }
                                    </select>
                                </div>

                                {/* Month & Year */}
                                <div>
                                    <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Month & Year</label>
                                    <select
                                        value={uploadModalMonth}
                                        onChange={(e) => setUploadModalMonth(e.target.value)}
                                        className="w-full h-8 bg-slate-50 border border-slate-300 rounded-lg px-2 text-xs font-semibold text-slate-800"
                                    >
                                        {availableMonths.map(m => {
                                            const [yr, mo] = m.split('-');
                                            const d = new Date(Number(yr), Number(mo) - 1, 1);
                                            return <option key={m} value={m}>{d.toLocaleString('en-US', { month: 'short', year: 'numeric' })} ({m})</option>;
                                        })}
                                    </select>
                                </div>
                            </div>

                            {/* File Dropzone */}
                            <div>
                                <label className="block text-[10px] font-bold uppercase text-slate-500 mb-1">Bill Document (PDF or Excel)</label>
                                <input
                                    type="file"
                                    ref={modalFileInputRef}
                                    accept=".pdf,.xlsx,.xls"
                                    onChange={(e) => setUploadModalFile(e.target.files?.[0] || null)}
                                    className="hidden"
                                />
                                <div
                                    onClick={() => modalFileInputRef.current?.click()}
                                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                                    onDragLeave={() => setIsDragging(false)}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        setIsDragging(false);
                                        if (e.dataTransfer.files?.[0]) setUploadModalFile(e.dataTransfer.files[0]);
                                    }}
                                    className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition ${
                                        isDragging ? 'border-blue-500 bg-blue-50/50' : 'border-slate-300 hover:border-blue-400 bg-slate-50/50'
                                    }`}
                                >
                                    {uploadModalFile ? (
                                        <div className="flex items-center justify-center gap-3">
                                            <span className="material-symbols-outlined text-emerald-600 text-[28px]">task</span>
                                            <div className="text-left">
                                                <div className="font-bold text-slate-900 text-xs">{uploadModalFile.name}</div>
                                                <div className="text-[10px] text-slate-500">{(uploadModalFile.size / 1024).toFixed(1)} KB &bull; Click to change file</div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="space-y-1.5">
                                            <span className="material-symbols-outlined text-blue-600 text-[32px]">cloud_upload</span>
                                            <p className="text-xs font-bold text-slate-800">
                                                Click to select or drag & drop MSEB Bill file
                                            </p>
                                            <p className="text-[10px] text-slate-400">
                                                Supports combined Electricity & Solar MSEDCL HT bill (.pdf, .xlsx, .xls)
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Modal Footer */}
                        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2.5">
                            <button
                                type="button"
                                disabled={isExtracting}
                                onClick={() => setIsUploadModalOpen(false)}
                                className="px-4 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition cursor-pointer"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                disabled={!uploadModalFile || isExtracting}
                                onClick={async () => {
                                    setSelectedLocation(uploadModalLocation);
                                    setSelectedPlantCode(uploadModalPlantCode);
                                    setSelectedMonth(uploadModalMonth);
                                    await handleBillUpload(uploadModalFile, uploadModalPlantCode, uploadModalMonth);
                                    setIsUploadModalOpen(false);
                                }}
                                className="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 rounded-lg transition shadow-xs flex items-center gap-1.5 cursor-pointer"
                            >
                                {isExtracting ? (
                                    <>
                                        <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                        </svg>
                                        <span>Extracting Bill...</span>
                                    </>
                                ) : (
                                    <>
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                                        </svg>
                                        <span>Extract & Compare Bill</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* CONFIRMATION MODAL FOR "ALLOW & APPLY TARIFF" */}
            {isAllowModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/75 backdrop-blur-xs animate-in fade-in duration-150">
                    <div className="bg-white dark:bg-[#151f32] rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg overflow-hidden">
                        <div className="px-5 py-4 bg-blue-600 text-white flex items-center justify-between">
                            <div className="flex items-center gap-2.5">
                                <span className="material-symbols-outlined text-[22px]">payments</span>
                                <h3 className="text-base font-bold">Confirm Tariff Rate Adoption</h3>
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsAllowModalOpen(false)}
                                className="text-white/80 hover:text-white transition bg-transparent border-none cursor-pointer"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        <div className="p-6 space-y-4 text-xs">
                            <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/60 p-3.5 rounded-xl">
                                <p className="text-blue-900 dark:text-blue-200 font-medium leading-relaxed">
                                    You are about to adopt the actual MSEB billed tariff for <b>{selectedPlant?.plant_display_name || selectedPlantCode}</b>.
                                    This will update the active electricity tariff for all calculations starting from <b>{nextMonthInfo.label}</b>.
                                </p>
                            </div>

                            <div className="grid grid-cols-2 gap-3 text-slate-700 dark:text-slate-300">
                                <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                                    <span className="text-slate-400 block text-[10px] font-bold uppercase">Current Baseline Rate</span>
                                    <strong className="text-base font-black text-slate-800 dark:text-white">
                                        ₹{baselineSoftwareTariff.toFixed(2)} / kWh
                                    </strong>
                                </div>
                                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg border border-emerald-200 dark:border-emerald-800">
                                    <span className="text-emerald-700 dark:text-emerald-400 block text-[10px] font-bold uppercase">New MSEB Bill Rate</span>
                                    <strong className="text-base font-black text-emerald-700 dark:text-emerald-300">
                                        ₹{billEnergyRate?.toFixed(2)} / kWh
                                    </strong>
                                </div>
                            </div>

                            <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2 bg-slate-50/50 dark:bg-slate-800/40">
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Effective Date:</span>
                                    <span className="font-bold text-slate-800 dark:text-white">{nextMonthInfo.firstDate} (1st of {nextMonthInfo.label})</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Unit Variance:</span>
                                    <span className={`font-bold ${rateDiff < 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                        {rateDiff > 0 ? '+' : ''}{rateDiff.toFixed(2)} / unit
                                    </span>
                                </div>
                                {billUnitsKvah && (
                                    <div className="flex justify-between border-t border-slate-200 dark:border-slate-700 pt-2">
                                        <span className="text-slate-500">Est. Monthly Cost Impact:</span>
                                        <span className="font-extrabold text-slate-900 dark:text-white">
                                            ₹ {Math.abs(Math.round(billUnitsKvah * rateDiff)).toLocaleString('en-IN')} {rateDiff < 0 ? '(Estimated Savings)' : '(Estimated Addition)'}
                                        </span>
                                    </div>
                                )}
                            </div>

                            <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                <input
                                    type="checkbox"
                                    checked={recalculateNextEntries}
                                    onChange={(e) => setRecalculateNextEntries(e.target.checked)}
                                    className="rounded text-blue-600 focus:ring-blue-500 h-4 w-4"
                                />
                                <span className="text-xs text-slate-700 dark:text-slate-300">
                                    Recalculate already-recorded daily entries of {nextMonthInfo.label} with this new rate.
                                </span>
                            </label>
                        </div>

                        <div className="px-6 py-3.5 bg-slate-50 dark:bg-[#182338] border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2.5">
                            <button
                                type="button"
                                disabled={isApplyingTariff}
                                onClick={() => setIsAllowModalOpen(false)}
                                className="px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-100 transition cursor-pointer"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                disabled={isApplyingTariff}
                                onClick={handleConfirmAllowTariff}
                                className="px-4 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                            >
                                {isApplyingTariff ? 'Updating System...' : 'Confirm & Apply Tariff'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* TOP HEADER: TITLE + SUB-TABS (LEFT) & ACTIVE BILL INFO + UPLOAD + EXPORT ACTIONS (RIGHT) */}
            <div className="shrink-0 flex flex-col lg:flex-row lg:items-center justify-between gap-1.5 border-b border-slate-200 pb-1.5">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-4.5 bg-blue-600 rounded-full inline-block" />
                        <h1 className="text-sm sm:text-base font-black tracking-tight text-slate-900">
                            Monthly Electricity & Solar Variance
                        </h1>
                    </div>

                    {/* Sub-Tab Navigation Pills */}
                    <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                        <button
                            type="button"
                            onClick={() => setActiveSubTab('variance')}
                            className={`px-2 py-0.5 rounded text-xs font-bold transition cursor-pointer border-none ${
                                activeSubTab === 'variance'
                                    ? 'bg-white text-blue-700 shadow-2xs'
                                    : 'text-slate-600 hover:text-slate-900 bg-transparent'
                            }`}
                        >
                            Variance Table
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveSubTab('tariff_progression')}
                            className={`px-2 py-0.5 rounded text-xs font-bold transition cursor-pointer border-none ${
                                activeSubTab === 'tariff_progression'
                                    ? 'bg-white text-blue-700 shadow-2xs'
                                    : 'text-slate-600 hover:text-slate-900 bg-transparent'
                            }`}
                        >
                            MSEB Tariff Progression
                        </button>
                    </div>
                </div>

                {/* Right Side: Active Bill Document + View Bill + Baseline/Bill Rate + Upload Bill + Export */}
                <div className="flex flex-wrap items-center gap-1.5 shrink-0 self-end lg:self-auto text-xs">
                    {activeBill?.fileName && (
                        <div className="flex items-center gap-1">
                            <span className="bg-slate-100 text-slate-700 font-mono text-[11px] px-2 py-0.5 rounded border border-slate-200 max-w-[160px] sm:max-w-[200px] truncate" title={activeBill.fileName}>
                                {activeBill.fileName}
                            </span>

                            <button
                                type="button"
                                onClick={() => setIsPreviewModalOpen(true)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded shadow-2xs transition cursor-pointer"
                            >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                                <span>View Bill</span>
                            </button>
                        </div>
                    )}

                    <div className="text-[11px] text-slate-500 whitespace-nowrap hidden sm:inline-block">
                        Baseline: <b>₹{baselineSoftwareTariff.toFixed(2)}</b> &bull; Bill Rate: <b className="text-emerald-700">{activeBill?.energyTariffRate ? `₹${Number(activeBill.energyTariffRate).toFixed(2)}/kWh` : '—'}</b>
                    </div>

                    <button
                        type="button"
                        onClick={handleOpenUploadModal}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-xs transition cursor-pointer border-none"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                        <span>Upload Bill (PDF/Excel)</span>
                    </button>

                    {Object.keys(savedBills).length > 0 && (
                        <button
                            type="button"
                            onClick={handleClearAllBills}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg shadow-2xs transition cursor-pointer"
                            title="Clear all uploaded bills to start fresh"
                        >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                            <span>Clear Data</span>
                        </button>
                    )}

                    {activeSubTab === 'variance' ? (
                        <button
                            type="button"
                            onClick={handleExportExcel}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 shadow-2xs transition cursor-pointer"
                        >
                            <svg className="w-3.5 h-3.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <span>Export (.xlsx)</span>
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={handleExportTariffAuditExcel}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-2xs transition cursor-pointer border-none"
                        >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <span>Export Audit (.xlsx)</span>
                        </button>
                    )}
                </div>
            </div>

            {/* QUICK MONTH SELECTOR PILL BAR FOR VARIANCE TABLE (CHRONOLOGICAL JAN TO DEC) */}
            {activeSubTab === 'variance' && (
                <div className="shrink-0 mt-1 flex items-center justify-between gap-1.5 bg-white px-2.5 py-1 rounded-lg border border-slate-200 shadow-2xs">
                    <div className="flex items-center gap-1 overflow-x-auto py-0.5">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider shrink-0 flex items-center gap-1">
                            <span className="material-symbols-outlined text-[14px]">calendar_month</span>
                            Month:
                        </span>
                        {availableMonths.map((m) => {
                            const isSelected = m === selectedMonth;
                            const key = `${selectedPlant?.plant_code || selectedPlantCode}_${m}`;
                            const billItem = savedBills[key];
                            const hasBill = Boolean(billItem);
                            const [yr, mo] = m.split('-').map(Number);
                            const label = new Date(yr, mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

                            return (
                                <button
                                    key={m}
                                    type="button"
                                    onClick={() => setSelectedMonth(m)}
                                    className={`px-2 py-0.5 rounded text-[11px] font-bold transition flex items-center gap-1 shrink-0 cursor-pointer ${
                                        isSelected
                                            ? 'bg-blue-600 text-white shadow-xs'
                                            : hasBill
                                                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100'
                                                : 'bg-slate-100 text-slate-500 hover:bg-slate-200 border border-transparent'
                                    }`}
                                >
                                    {hasBill && (
                                        <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-white' : 'bg-emerald-500'}`} />
                                    )}
                                    <span>{label}</span>
                                    {hasBill && (
                                        <span className={`text-[8.5px] px-1 py-0 rounded font-mono ${
                                            isSelected ? 'bg-blue-700 text-blue-100' : 'bg-emerald-100 text-emerald-800'
                                        }`}>
                                            Bill
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    <div className="hidden sm:flex items-center gap-1 shrink-0 text-[11px] text-slate-500">
                        <span className="font-semibold text-slate-700">Active View:</span>
                        <span className="font-bold text-blue-700 font-mono bg-blue-50 px-1.5 py-0.2 rounded border border-blue-200">
                            {selectedMonth} ({selectedPlant?.plant_display_name || 'NGM'})
                        </span>
                    </div>
                </div>
            )}

            {/* MSEB TARIFF PROGRESSION: COMPACT KPI STRIP FIXED IN HEADER */}
            {activeSubTab === 'tariff_progression' && (
                <div className="shrink-0 mt-1 grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
                    <div className="bg-white px-2.5 py-1 rounded-lg border border-slate-200 flex items-center justify-between shadow-2xs">
                        <div>
                            <span className="text-[8.5px] font-bold uppercase tracking-wider text-slate-400 block">Baseline Rate</span>
                            <strong className="text-xs font-black text-slate-800">₹ {baselineSoftwareTariff.toFixed(2)}</strong>
                        </div>
                        <span className="material-symbols-outlined text-slate-400 text-[16px]">tune</span>
                    </div>

                    <div className="bg-white px-2.5 py-1 rounded-lg border border-slate-200 flex items-center justify-between shadow-2xs">
                        <div>
                            <span className="text-[8.5px] font-bold uppercase tracking-wider text-slate-400 block">MSEB Bill Rate</span>
                            <strong className="text-xs font-black text-emerald-600">₹ {billEnergyRate ? billEnergyRate.toFixed(2) : '—'}</strong>
                        </div>
                        <span className="material-symbols-outlined text-emerald-500 text-[16px]">electric_bolt</span>
                    </div>

                    <div className="bg-white px-2.5 py-1 rounded-lg border border-slate-200 flex items-center justify-between shadow-2xs">
                        <div>
                            <span className="text-[8.5px] font-bold uppercase tracking-wider text-slate-400 block">Rate Variance</span>
                            <strong className={`text-xs font-black ${rateDiff !== null && rateDiff < 0 ? 'text-emerald-600' : (rateDiff !== null && rateDiff > 0 ? 'text-rose-600' : 'text-slate-500')}`}>
                                {rateDiff !== null ? `${rateDiff > 0 ? '+' : ''}${rateDiff.toFixed(2)} / unit` : '—'}
                            </strong>
                        </div>
                        <span className="material-symbols-outlined text-blue-500 text-[16px]">trending_flat</span>
                    </div>

                    <div className="bg-white px-2.5 py-1 rounded-lg border border-slate-200 flex items-center justify-between shadow-2xs">
                        <div>
                            <span className="text-[8.5px] font-bold uppercase tracking-wider text-slate-400 block">Decision Status</span>
                            <strong className="text-[11px] font-bold text-slate-800 block truncate max-w-[130px]">
                                {currentDecision?.status === 'ALLOWED' ? '✓ Synced next month' : (currentDecision?.status === 'DENIED' ? '✕ Retained' : (billEnergyRate !== null ? 'Pending Review' : 'No Bill Uploaded'))}
                            </strong>
                        </div>
                        <span className="material-symbols-outlined text-purple-500 text-[16px]">gavel</span>
                    </div>
                </div>
            )}

            {/* Notifications */}
            {uploadError && (
                <div className="shrink-0 mt-1.5 bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700 flex items-center justify-between">
                    <span>⚠️ {uploadError}</span>
                    <button type="button" onClick={() => setUploadError('')} className="font-bold border-none bg-transparent cursor-pointer">✕</button>
                </div>
            )}
            {uploadSuccess && (
                <div className="shrink-0 mt-1.5 bg-emerald-50 border border-emerald-200 rounded-lg p-2 text-xs text-emerald-800 flex items-center justify-between">
                    <span>✓ {uploadSuccess}</span>
                    <button type="button" onClick={() => setUploadSuccess('')} className="font-bold border-none bg-transparent cursor-pointer">✕</button>
                </div>
            )}

            {/* Period Mismatch Alert */}
            {isPeriodMismatch && (
                <div className="shrink-0 mt-1.5 bg-amber-50 border-l-4 border-amber-500 p-2 rounded-r-lg shadow-2xs">
                    <div className="flex items-start justify-between">
                        <div>
                            <h4 className="text-xs font-bold text-amber-900">Billing Period Mismatch Detected</h4>
                            <p className="text-[11px] text-amber-800 mt-0.5">
                                The uploaded bill is for <b>{b?.billMonth}</b>, but selected month is <b>{selectedMonth}</b>.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setSelectedMonth(b.billMonth)}
                            className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-semibold transition border-none cursor-pointer"
                        >
                            Switch to {b.billMonth}
                        </button>
                    </div>
                </div>
            )}

            {/* SMART TARIFF REVISION NOTIFICATION BANNER WITH [ALLOW] & [DENY] PROMPT */}
            {hasRateRevision && activeSubTab === 'variance' && (
                <div className="mt-2 rounded-xl border border-amber-300 dark:border-amber-700/60 bg-gradient-to-r from-amber-50 via-amber-50/70 to-orange-50 dark:from-[#241a10] dark:to-[#2e1d13] p-3 shadow-2xs">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-2.5">
                        <div className="flex items-start gap-2.5">
                            <div className="h-8 w-8 rounded-lg bg-amber-500 text-white flex items-center justify-center shrink-0 shadow-2xs">
                                <span className="material-symbols-outlined text-[18px]">notifications_active</span>
                            </div>
                            <div>
                                <div className="flex items-center gap-2">
                                    <h4 className="text-xs font-black text-amber-900 dark:text-amber-200 uppercase tracking-wide">
                                        Tariff Revision Detected in Uploaded MSEB Bill!
                                    </h4>
                                    {currentDecision?.status && (
                                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                                            currentDecision.status === 'ALLOWED'
                                                ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                                : 'bg-slate-200 text-slate-700 border border-slate-300'
                                        }`}>
                                            {currentDecision.status === 'ALLOWED' ? '✓ ALLOWED & APPLIED' : '✕ DENIED (RETAINED EXISTING)'}
                                        </span>
                                    )}
                                </div>
                                <p className="text-[11px] text-amber-950 dark:text-amber-300 mt-0.5 leading-relaxed">
                                    Previous period was calculated at <b>₹{baselineSoftwareTariff.toFixed(2)}/unit</b>.
                                    The uploaded bill active rate is <b>₹{billEnergyRate?.toFixed(2)}/unit</b> (Variance: <b className={rateDiff < 0 ? 'text-emerald-700 font-black' : 'text-rose-700 font-black'}>{rateDiff > 0 ? '+' : ''}{rateDiff.toFixed(2)} / unit</b>).
                                    Would you like to update software calculations to <b>₹{billEnergyRate?.toFixed(2)}/unit</b> for subsequent months starting from <b>{nextMonthInfo.label}</b>?
                                </p>
                            </div>
                        </div>

                        {/* Action Buttons: ALLOW vs DENY */}
                        <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                            {!currentDecision ? (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => setIsAllowModalOpen(true)}
                                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition shadow-2xs flex items-center gap-1 border-none cursor-pointer"
                                    >
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                                        </svg>
                                        <span>ALLOW & UPDATE TARIFF</span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={handleDenyTariffRevision}
                                        className="px-3 py-1.5 bg-white dark:bg-slate-800 hover:bg-slate-100 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-600 text-xs font-bold rounded-lg transition cursor-pointer"
                                    >
                                        <span>DENY (KEEP ₹{baselineSoftwareTariff.toFixed(2)})</span>
                                    </button>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => {
                                        saveTariffDecision(currentKey, null);
                                    }}
                                    className="px-2.5 py-1 text-[11px] font-semibold text-slate-600 bg-white border border-slate-300 rounded hover:bg-slate-50 transition cursor-pointer"
                                >
                                    Change Decision
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 1: ONE COMPARISON TABLE — ONLY TWO CATEGORIES (ELECTRICITY AND SOLAR) WITH FIXED/STICKY HEADER */}
            {activeSubTab === 'variance' && (
                <div className="flex-1 min-h-0 mt-1 flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    {/* Table Header Bar */}
                    <div className="shrink-0 px-3 py-1.5 bg-slate-900 text-white flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-slate-800">
                        <div>
                            <div className="flex items-center gap-2">
                                <h2 className="text-xs sm:text-sm font-bold tracking-wide">
                                    Monthly Variance Comparison — {selectedPlant?.plant_display_name || 'NGM'} ({selectedMonth})
                                </h2>
                                {activeBill ? (
                                    <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[9px] font-bold px-2 py-0.5 rounded-full tracking-wider uppercase">
                                        ✓ Bill Uploaded
                                    </span>
                                ) : (
                                    <span className="bg-slate-700 text-slate-300 border border-slate-600 text-[9px] font-bold px-2 py-0.5 rounded-full tracking-wider uppercase">
                                        No Bill Uploaded
                                    </span>
                                )}
                            </div>
                            <p className="text-[10px] text-slate-400 mt-0.5">
                                {activeBill ? (
                                    <>MSEDCL HT-I A Industrial Bill (Consumer: {b?.consumerNo || '—'}) vs Software Database | Energy Tariff: <b>₹{activeEnergyTariff.toFixed(2)}/kWh</b></>
                                ) : (
                                    <>No MSEB bill uploaded for {selectedMonth}. Click 'Upload Bill (PDF/Excel)' above to compare.</>
                                )}
                            </p>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs">
                            <span className="text-slate-300 font-mono text-[10px] bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                                Formula: <b>Variance = Software Value − Adjusted Bill Value</b>
                            </span>
                        </div>
                    </div>

                    {/* Scrollable Table with Sticky Header */}
                    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
                        <table className="w-full text-left border-collapse" id="variance-table">
                            <thead className="sticky top-0 bg-slate-100 z-10 shadow-2xs">
                                <tr className="border-b border-slate-200 text-slate-700 text-[11px] uppercase tracking-wider font-semibold">
                                    <th className="py-1.5 px-3 w-32 bg-slate-100">Category</th>
                                    <th className="py-1.5 px-3 bg-slate-100">Particulars</th>
                                    <th className="py-1.5 px-3 text-right bg-slate-100">Actual Bill Value</th>
                                    <th className="py-1.5 px-3 text-right bg-slate-100">Software Monthly Value</th>
                                    <th className="py-1.5 px-3 text-right bg-slate-100">Variance</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200 text-xs">
                                {/* CATEGORY 1: ELECTRICITY */}
                                {electricityRows.map((row, idx) => {
                                    const diff = row.rawVariance;
                                    let badgeClass = 'text-slate-400';
                                    if (row.isComparable && diff !== null && diff !== undefined && !isNaN(diff)) {
                                        const absDiff = Math.abs(diff);
                                        if (diff === 0) {
                                            badgeClass = 'text-emerald-700 font-semibold bg-emerald-50 border border-emerald-200 px-1.5 py-0.2 rounded text-[11px]';
                                        } else if (absDiff <= 500 || (row.isFinancial && absDiff <= 5000)) {
                                            badgeClass = 'text-emerald-800 font-semibold bg-emerald-50 border border-emerald-300 px-1.5 py-0.2 rounded text-[11px]';
                                        } else {
                                            badgeClass = diff > 0
                                                ? 'text-blue-700 font-semibold bg-blue-50 border border-blue-200 px-1.5 py-0.2 rounded text-[11px]'
                                                : 'text-amber-700 font-semibold bg-amber-50 border border-amber-200 px-1.5 py-0.2 rounded text-[11px]';
                                        }
                                    }

                                    return (
                                        <tr
                                            key={row.id}
                                            className={`hover:bg-slate-50/80 transition-colors ${
                                                row.isHighlight ? 'bg-blue-50/30 font-semibold' : ''
                                            }`}
                                        >
                                            {idx === 0 && (
                                                <td
                                                    rowSpan={electricityRows.length}
                                                    className="py-2 px-3 align-top font-bold text-blue-900 bg-blue-50/40 border-r border-slate-200 uppercase tracking-wider text-[11px]"
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-blue-600 inline-block" />
                                                        ELECTRICITY
                                                    </div>
                                                </td>
                                            )}
                                            <td className="py-1.5 px-3">
                                                <div className="font-semibold text-slate-900 text-xs">
                                                    {row.particulars}
                                                </div>
                                                <div className="text-[10px] text-slate-500 mt-0.2 font-normal leading-tight">
                                                    {row.detail}
                                                </div>
                                            </td>
                                            <td className="py-1.5 px-3 text-right font-medium text-slate-800 text-xs">
                                                {row.billVal}
                                            </td>
                                            <td className="py-1.5 px-3 text-right font-medium text-slate-800 text-xs">
                                                {row.sysVal}
                                            </td>
                                            <td className="py-1.5 px-3 text-right">
                                                {row.isComparable ? (
                                                    <span className={badgeClass}>
                                                        {row.variance}
                                                    </span>
                                                ) : (
                                                    <span className="text-slate-400 font-mono">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}

                                {/* CATEGORY 2: SOLAR */}
                                {solarRows.map((row, idx) => {
                                    const diff = row.rawVariance;
                                    let badgeClass = 'text-slate-400';
                                    if (row.isComparable && diff !== null && diff !== undefined && !isNaN(diff)) {
                                        const absDiff = Math.abs(diff);
                                        if (diff === 0) {
                                            badgeClass = 'text-emerald-700 font-semibold bg-emerald-50 border border-emerald-200 px-1.5 py-0.2 rounded text-[11px]';
                                        } else if (absDiff <= 500 || (row.isFinancial && absDiff <= 5000)) {
                                            badgeClass = 'text-emerald-800 font-semibold bg-emerald-50 border border-emerald-300 px-1.5 py-0.2 rounded text-[11px]';
                                        } else {
                                            badgeClass = diff > 0
                                                ? 'text-blue-700 font-semibold bg-blue-50 border border-blue-200 px-1.5 py-0.2 rounded text-[11px]'
                                                : 'text-amber-700 font-semibold bg-amber-50 border border-amber-200 px-1.5 py-0.2 rounded text-[11px]';
                                        }
                                    }

                                    return (
                                        <tr
                                            key={row.id}
                                            className="hover:bg-slate-50/80 transition-colors bg-amber-50/20 font-semibold"
                                        >
                                            {idx === 0 && (
                                                <td
                                                    rowSpan={solarRows.length}
                                                    className="py-2 px-3 align-top font-bold text-amber-900 bg-amber-50/40 border-r border-slate-200 uppercase tracking-wider text-[11px]"
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-600 inline-block" />
                                                        SOLAR
                                                    </div>
                                                </td>
                                            )}
                                            <td className="py-1.5 px-3">
                                                <div className="font-semibold text-slate-900 text-xs">
                                                    {row.particulars}
                                                </div>
                                                <div className="text-[10px] text-slate-500 mt-0.2 font-normal leading-tight">
                                                    {row.detail}
                                                </div>
                                            </td>
                                            <td className="py-1.5 px-3 text-right font-medium text-slate-800 text-xs">
                                                {row.billVal}
                                            </td>
                                            <td className="py-1.5 px-3 text-right font-medium text-slate-800 text-xs">
                                                {row.sysVal}
                                            </td>
                                            <td className="py-1.5 px-3 text-right">
                                                {row.isComparable ? (
                                                    <span className={badgeClass}>
                                                        {row.variance}
                                                    </span>
                                                ) : (
                                                    <span className="text-slate-400 font-mono">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* Table Footer Notes */}
                    <div className="shrink-0 px-3 py-1 bg-slate-50 border-t border-slate-200 text-[10px] text-slate-600 flex flex-col md:flex-row md:items-center justify-between gap-1">
                        <div className="space-y-0.2">
                            <div>
                                <b>Audit Variance Standard:</b> Positive (+) = Software higher; Negative (−) = Software lower.
                            </div>
                            <div className="text-slate-500">
                                <b>MERC Net Billing Rule:</b> Software Net Units = Gross Meter − Discom Solar Export Credit.
                            </div>
                        </div>
                        <div className="text-left md:text-right text-slate-500 font-medium">
                            Base Energy Charges = Net Billed Units × ₹{activeEnergyTariff.toFixed(2)}/kWh | Grid Support Fee = Solar Gen × ₹{activeGridSupportTariff.toFixed(2)}/kWh
                        </div>
                    </div>
                </div>
            )}

            {/* TAB 2: MSEB TARIFF PROGRESSION & AUDIT REPORT VIEW WITH FIXED TABLE */}
            {activeSubTab === 'tariff_progression' && (
                <div className="flex-1 min-h-0 mt-1 flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <div className="shrink-0 px-3 py-1.5 bg-slate-900 text-white flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-slate-800">
                        <div>
                            <h3 className="text-xs sm:text-sm font-bold tracking-wide">
                                MSEB Tariff Progression & Audit Trail — {selectedPlant?.plant_display_name || 'NGM'}
                            </h3>
                            <p className="text-[10px] text-slate-400 mt-0.5">
                                Chronological history of MSEB bill tariffs, baseline variances, and user Allow/Deny decisions.
                            </p>
                        </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">
                        <table className="w-full text-left border-collapse text-xs">
                            <thead className="sticky top-0 bg-slate-100 z-10 shadow-2xs">
                                <tr className="bg-slate-100 text-slate-700 font-semibold border-b border-slate-200 uppercase tracking-wider text-[10.5px]">
                                    <th className="py-2 px-2.5 bg-slate-100 whitespace-nowrap">Period Month</th>
                                    <th className="py-2 px-2.5 text-right bg-slate-100 whitespace-nowrap">Past Reading (Opening)</th>
                                    <th className="py-2 px-2.5 text-right bg-slate-100 whitespace-nowrap">Current Reading (Closing)</th>
                                    <th className="py-2 px-2.5 text-right bg-slate-100 whitespace-nowrap">Billed Units (kVAh)</th>
                                    <th className="py-2 px-2.5 text-right bg-slate-100 whitespace-nowrap">Software Baseline</th>
                                    <th className="py-2 px-2.5 text-right bg-slate-100 whitespace-nowrap">MSEB Billed Rate</th>
                                    <th className="py-2.5 px-3 text-right bg-slate-100 whitespace-nowrap">Rate Diff</th>
                                    <th className="py-2.5 px-3 text-right bg-slate-100 whitespace-nowrap">Cost Impact (₹)</th>
                                    <th className="py-2.5 px-3 text-center bg-slate-100 whitespace-nowrap">Decision Status</th>
                                    <th className="py-2.5 px-3 text-center bg-slate-100 whitespace-nowrap">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {tariffProgressionData.map((row) => {
                                    return (
                                        <tr key={row.monthKey} className="hover:bg-slate-50/80 transition-colors">
                                            <td className="py-1.5 px-2.5 font-bold text-slate-900 whitespace-nowrap">
                                                {row.monthLabel}
                                                <span className="block text-[9.5px] font-mono text-slate-400">{row.monthKey}</span>
                                            </td>

                                            {/* PAST READING (OPENING) */}
                                            <td className="py-1.5 px-2.5 text-right whitespace-nowrap">
                                                {row.openingMeter !== null ? (
                                                    <div>
                                                        <span className="font-bold text-slate-800 font-mono text-[11px]">
                                                            {Number(row.openingMeter).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                        </span>
                                                        {row.solarGenOpening !== null && (
                                                            <div className="text-[9.5px] text-amber-700 font-semibold font-mono" title="Solar Gen Opening">
                                                                ☀️ {Number(row.solarGenOpening).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <span className="text-slate-400 font-mono">—</span>
                                                )}
                                            </td>

                                            {/* CURRENT READING (CLOSING) */}
                                            <td className="py-1.5 px-2.5 text-right whitespace-nowrap">
                                                {row.closingMeter !== null ? (
                                                    <div>
                                                        <span className="font-bold text-slate-800 font-mono text-[11px]">
                                                            {Number(row.closingMeter).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                        </span>
                                                        {row.solarGenClosing !== null && (
                                                            <div className="text-[9.5px] text-amber-700 font-semibold font-mono" title="Solar Gen Closing">
                                                                ☀️ {Number(row.solarGenClosing).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <span className="text-slate-400 font-mono">—</span>
                                                )}
                                            </td>

                                            <td className="py-1.5 px-2.5 text-right font-medium text-slate-700 whitespace-nowrap">
                                                {row.billedUnits ? (
                                                    <div>
                                                        <span className="font-semibold">{row.billedUnits.toLocaleString()}</span>
                                                        {row.meterDifference !== null && (
                                                            <div className="text-[9px] text-slate-400 font-mono">
                                                                Δ {row.meterDifference?.toLocaleString()} × {row.multiplyingFactor}
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : '—'}
                                            </td>

                                            <td className="py-1.5 px-2.5 text-right font-semibold text-slate-800 whitespace-nowrap">
                                                ₹ {row.softwareRate.toFixed(2)}
                                            </td>

                                            <td className="py-1.5 px-2.5 text-right font-bold text-emerald-700 whitespace-nowrap">
                                                {row.billRate ? `₹ ${row.billRate.toFixed(2)}` : <span className="text-slate-400 font-normal">No bill</span>}
                                            </td>

                                            <td className="py-1.5 px-2.5 text-right font-bold whitespace-nowrap">
                                                {row.rateDiff !== null ? (
                                                    <span className={row.rateDiff < 0 ? 'text-emerald-600' : (row.rateDiff > 0 ? 'text-rose-600' : 'text-slate-500')}>
                                                        {row.rateDiff > 0 ? '+' : ''}{row.rateDiff.toFixed(2)}
                                                    </span>
                                                ) : '—'}
                                            </td>

                                            <td className="py-1.5 px-2.5 text-right font-bold text-slate-900 whitespace-nowrap">
                                                {row.costImpact ? (
                                                    <span className={row.costImpact < 0 ? 'text-emerald-700' : 'text-rose-700'}>
                                                        ₹ {Math.abs(row.costImpact).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                                    </span>
                                                ) : '—'}
                                            </td>

                                            <td className="py-1.5 px-2.5 text-center whitespace-nowrap">
                                                {row.status === 'ALLOWED' && (
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9.5px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-300">
                                                        ✓ ALLOWED (Synced)
                                                    </span>
                                                )}
                                                {row.status === 'DENIED' && (
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9.5px] font-bold bg-slate-100 text-slate-700 border border-slate-300">
                                                        ✕ DENIED (Retained)
                                                    </span>
                                                )}
                                                {row.status === 'MATCHED' && (
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9.5px] font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                                        100% Match
                                                    </span>
                                                )}
                                                {row.status === 'PENDING' && (
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9.5px] font-bold bg-amber-50 text-amber-800 border border-amber-300">
                                                        Pending Approval
                                                    </span>
                                                )}
                                                {row.status === 'NO_BILL' && (
                                                    <span className="text-slate-400 font-mono text-[10px]">No bill</span>
                                                )}
                                            </td>

                                            <td className="py-1.5 px-2.5 text-center whitespace-nowrap">
                                                <div className="flex items-center justify-center gap-1.5">
                                                    {row.hasBill && (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                setSelectedMonth(row.monthKey);
                                                                setIsPreviewModalOpen(true);
                                                            }}
                                                            className="px-2 py-0.5 rounded font-semibold text-[10.5px] bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition cursor-pointer"
                                                            title="View Uploaded PDF"
                                                        >
                                                            View PDF
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setSelectedMonth(row.monthKey);
                                                            setActiveSubTab('variance');
                                                        }}
                                                        className="px-2 py-0.5 rounded font-bold text-[10.5px] bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 transition cursor-pointer"
                                                        title="Open Month in Variance Comparison Table"
                                                    >
                                                        View Variance
                                                    </button>
                                                    {row.status === 'PENDING' && (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                setSelectedMonth(row.monthKey);
                                                                setActiveSubTab('variance');
                                                            }}
                                                            className="px-2 py-0.5 rounded font-bold text-[10.5px] bg-blue-600 hover:bg-blue-700 text-white transition border-none cursor-pointer"
                                                            title="Review & Decide Rate Revision"
                                                        >
                                                            Review Rate
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    <div className="shrink-0 px-3 py-1 bg-slate-50 border-t border-slate-200 text-[9.5px] text-slate-500 flex items-center justify-between">
                        <span>MSEDCL Tariff Progression & Variance Audit Module &bull; UtilitySense</span>
                        <span>Effective rate formula: Base Energy Tariff + Verified MERC Grid Support Fee</span>
                    </div>
                </div>
            )}
        </div>
    );
}
