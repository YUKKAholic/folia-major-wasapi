// src/components/modal/settings/DownloadLocationRow.tsx
// Shows where downloaded songs are saved and opens that folder in the OS file manager.

import React, { useEffect, useState } from 'react';
import { Download, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const DownloadLocationRow: React.FC = () => {
    const { t } = useTranslation();
    const [directory, setDirectory] = useState('');

    useEffect(() => {
        let cancelled = false;
        void window.electron?.download?.getDirectory?.().then((result) => {
            if (!cancelled && result?.path) setDirectory(result.path);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    if (!window.electron?.download) return null;

    return (
        <div className="pt-3 border-t border-white/10 space-y-3">
            <div className="space-y-1">
                <div className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                    <Download size={14} />
                    {t('options.downloadLocation') || 'Download Location'}
                </div>
                <div className="text-xs opacity-50" style={{ color: 'var(--text-secondary)' }}>
                    {t('options.downloadLocationDesc') || 'Songs you download from a playlist are saved here.'}
                </div>
            </div>

            <div className="flex gap-2">
                <div className="flex-1 bg-black/10 rounded-lg border border-white/5 px-3 py-2 min-w-0">
                    <div className="text-[11px] break-all font-mono" style={{ color: 'var(--text-primary)' }}>
                        {directory || '...'}
                    </div>
                </div>
                <button
                    onClick={() => void window.electron?.download?.openDirectory?.()}
                    className="shrink-0 w-12 rounded-lg text-sm font-medium transition-colors flex items-center justify-center bg-white/10 hover:bg-white/15"
                    style={{ color: 'var(--text-primary)' }}
                    title={t('options.openDownloadLocation') || 'Open Folder'}
                    aria-label={t('options.openDownloadLocation') || 'Open Folder'}
                >
                    <FolderOpen size={16} />
                </button>
            </div>
        </div>
    );
};

export default DownloadLocationRow;
