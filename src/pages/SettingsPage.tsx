import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Settings, Sparkles, Globe, Info } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useSettings } from '@/contexts/SettingsContext';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import McpTokensSection from '@/components/McpTokensSection';

export default function SettingsPage() {
  const { distanceUnit, setDistanceUnit, timezone, setTimezone } = useSettings();

  const timezones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [Intl.DateTimeFormat().resolvedOptions().timeZone];

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-mono font-bold text-foreground">Settings</h2>
        </div>

        {/* Preferences */}
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-4">
              <Globe className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-mono font-semibold text-foreground">Preferences</h3>
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs font-mono">Distance Unit</Label>
                <Select value={distanceUnit} onValueChange={(v: 'km' | 'mi') => setDistanceUnit(v)}>
                  <SelectTrigger className="font-mono text-xs">
                    <SelectValue placeholder="Select unit" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="km">Kilometers (km)</SelectItem>
                    <SelectItem value="mi">Miles (mi)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  Used for displaying distances and speed.
                </p>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-mono">Timezone</Label>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger className="font-mono text-xs">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[250px]">
                    {timezones.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  Used for displaying dates and times.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* AI status (read-only, configured by admin) */}
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Sparkles className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-mono font-semibold text-foreground">AI Assistant</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              AI features (session analysis + chat) are powered by a shared Google Gemini key configured by the
              system administrator. No per-user setup is required. Daily fair-use limits apply.
            </p>
          </CardContent>
        </Card>

        {/* MCP Tokens */}
        <McpTokensSection />

        {/* About */}
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Info className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-mono font-semibold text-foreground">About</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Xpeed is a personal data viewer for OBD2 logs exported from Car Scanner, Torque Pro,
              and similar apps. Manage multiple vehicles and track their health separately. Always consult a
              professional for serious vehicle issues.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
