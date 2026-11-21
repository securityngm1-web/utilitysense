import React from 'react';

/**
 * BillPreviewModal Component
 * Displays the original uploaded MSEDCL Bill PDF alongside key extracted audit metrics.
 */
export default function BillPreviewModal({ isOpen, onClose, billData, fileUrl, plantName, monthLabel }) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-900/80 backdrop-blur-xs animate-in fade-in duration-200">
            <div className="bg-white dark:bg-[#151f32] rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-6xl h-[92vh] flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-[#182338]">
                    <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-xl bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                        </div>
                        <div>
                            <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                <span>Uploaded MSEB Bill Document</span>
                                <span className="text-xs px-2 py-0.5 rounded-md font-semibold bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 border border-blue-200 dark:border-blue-900">
                                    {monthLabel || billData?.billMonth || 'Current Month'}
                                </span>
                            </h3>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                {plantName || 'Plant'} &bull; {billData?.fileName || 'Reference Bill Document'}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        {fileUrl && (
                            <a
                                href={fileUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition flex items-center gap-1.5 no-underline"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                                <span>Open Fullscreen</span>
                            </a>
                        )}

                        <button
                            type="button"
                            onClick={onClose}
                            className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-200/60 dark:hover:bg-slate-800 transition border-none bg-transparent cursor-pointer"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Quick Metrics Bar */}
                <div className="px-5 py-2.5 bg-slate-100/60 dark:bg-[#111927] border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-4 text-xs font-medium text-slate-600 dark:text-slate-400">
                    <div>
                        <span className="text-slate-400 mr-1.5">Consumer No:</span>
                        <strong className="text-slate-800 dark:text-slate-200 font-mono">{billData?.consumerNo || '170019022640'}</strong>
                    </div>
                    <div className="h-3.5 w-px bg-slate-300 dark:bg-slate-700" />
                    <div>
                        <span className="text-slate-400 mr-1.5">Billed kVAh:</span>
                        <strong className="text-blue-600 dark:text-blue-400 font-bold">{billData?.billedUnitsKvah?.toLocaleString() || '—'} kVAh</strong>
                    </div>
                    <div className="h-3.5 w-px bg-slate-300 dark:bg-slate-700" />
                    <div>
                        <span className="text-slate-400 mr-1.5">Billed kWh:</span>
                        <strong className="text-slate-800 dark:text-slate-200 font-bold">{billData?.billedUnitsKwh?.toLocaleString() || '—'} kWh</strong>
                    </div>
                    <div className="h-3.5 w-px bg-slate-300 dark:bg-slate-700" />
                    <div>
                        <span className="text-slate-400 mr-1.5">Energy Rate:</span>
                        <strong className="text-emerald-600 dark:text-emerald-400 font-bold">₹{(billData?.energyTariffRate || 8.44).toFixed(2)}/unit</strong>
                    </div>
                    <div className="h-3.5 w-px bg-slate-300 dark:bg-slate-700" />
                    <div>
                        <span className="text-slate-400 mr-1.5">Total Bill:</span>
                        <strong className="text-slate-900 dark:text-white font-black">₹{billData?.totalCurrentBill?.toLocaleString('en-IN', { maximumFractionDigits: 2 }) || '—'}</strong>
                    </div>
                    <div className="h-3.5 w-px bg-slate-300 dark:bg-slate-700" />
                    <div>
                        <span className="text-slate-400 mr-1.5">Solar Gen:</span>
                        <strong className="text-amber-600 dark:text-amber-400 font-bold">{billData?.solarGenUnits?.toLocaleString() || '—'} kWh</strong>
                    </div>
                </div>

                {/* PDF Viewer Body */}
                <div className="flex-1 bg-slate-100 dark:bg-slate-900 overflow-hidden relative">
                    {fileUrl ? (
                        <iframe
                            src={fileUrl}
                            title="MSEDCL Electricity Bill Document"
                            className="w-full h-full border-none"
                        />
                    ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center text-slate-500">
                            <div className="w-16 h-16 rounded-2xl bg-slate-200 dark:bg-slate-800 flex items-center justify-center text-slate-400 mb-4">
                                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                </svg>
                            </div>
                            <h4 className="text-base font-bold text-slate-800 dark:text-slate-200 mb-1">
                                Reference Bill Record
                            </h4>
                            <p className="text-xs text-slate-500 max-w-md mb-4">
                                This month is currently using the system reference bill parameters. Uploading an actual PDF bill for this month will allow full interactive document viewing here.
                            </p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-2.5 bg-slate-50 dark:bg-[#182338] border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
                    <span>MSEDCL HT-Industrial Combined Energy & Solar Bill Audit Document</span>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-1.5 text-xs font-semibold text-white bg-slate-800 dark:bg-slate-700 hover:bg-slate-900 dark:hover:bg-slate-600 rounded-lg transition border-none cursor-pointer"
                    >
                        Close Preview
                    </button>
                </div>
            </div>
        </div>
    );
}
