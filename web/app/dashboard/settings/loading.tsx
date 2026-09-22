import { BillingSkeleton, PreferencesSkeleton } from './SettingsSkeleton';
import { SettingsShell } from './SettingsShell';

export default function LoadingSettings() {
  return <SettingsShell><BillingSkeleton /><PreferencesSkeleton /></SettingsShell>;
}
