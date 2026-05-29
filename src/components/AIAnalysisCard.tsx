import { Card, CardContent } from '@/components/ui/card';
import { Sparkles, Lightbulb, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface AIAnalysisCardProps {
  analysis: {
    summary: string;
    insights: string[];
    recommendations: string[];
    timestamp: string;
  };
}

export default function AIAnalysisCard({ analysis }: AIAnalysisCardProps) {
  if (!analysis) return null;

  return (
    <Card className="bg-card border-border border-primary/30 shadow-sm overflow-hidden">
      <div className="bg-primary/5 border-b border-primary/10 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center shadow-inner">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-lg font-mono font-bold text-foreground">AI Diagnostic Report</h3>
            <p className="text-xs text-muted-foreground font-mono">
              Generated {new Date(analysis.timestamp).toLocaleString()}
            </p>
          </div>
        </div>
        <Badge variant="outline" className="text-primary border-primary/30 bg-primary/5 font-mono">
          Powered by AI
        </Badge>
      </div>
      
      <CardContent className="p-6 space-y-8">
        {/* Summary Section */}
        {analysis.summary && (
          <div className="bg-background/50 rounded-lg p-4 border border-border/50">
            <h4 className="text-sm font-mono font-bold text-foreground mb-3 flex items-center gap-2 uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              Executive Summary
            </h4>
            <p className="text-base text-muted-foreground leading-relaxed">
              {analysis.summary}
            </p>
          </div>
        )}

        {/* Insights Section */}
        {analysis.insights && analysis.insights.length > 0 && (
          <div>
            <h4 className="text-sm font-mono font-bold text-foreground mb-4 flex items-center gap-2 uppercase tracking-wider text-amber-500">
              <Lightbulb className="w-4 h-4" />
              Key Insights
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {analysis.insights.map((insight, idx) => {
                const isCritical = insight.toLowerCase().includes('critical') || insight.toLowerCase().includes('severe');
                const isWarning = insight.toLowerCase().includes('warning') || insight.toLowerCase().includes('attention');
                
                return (
                  <div 
                    key={idx} 
                    className={`
                      relative p-4 rounded-lg border bg-card/50 transition-colors
                      ${isCritical ? 'border-destructive/40 bg-destructive/5' : 
                        isWarning ? 'border-amber-500/40 bg-amber-500/5' : 
                        'border-border hover:border-primary/30'}
                    `}
                  >
                    {isCritical && <AlertTriangle className="absolute top-4 right-4 w-4 h-4 text-destructive opacity-70" />}
                    <p className="text-sm text-foreground leading-relaxed">{insight}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Recommendations Section */}
        {analysis.recommendations && analysis.recommendations.length > 0 && (
          <div>
            <h4 className="text-sm font-mono font-bold text-foreground mb-4 flex items-center gap-2 uppercase tracking-wider text-emerald-500">
              <CheckCircle2 className="w-4 h-4" />
              Recommended Actions
            </h4>
            <div className="space-y-3">
              {analysis.recommendations.map((rec, idx) => (
                <div key={idx} className="flex gap-4 p-3 rounded-md hover:bg-muted/50 transition-colors group">
                  <div className="mt-1 flex-shrink-0">
                    <div className="w-5 h-5 rounded-full border-2 border-emerald-500/30 group-hover:border-emerald-500 flex items-center justify-center transition-colors">
                      <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </div>
                  <p className="text-base text-muted-foreground group-hover:text-foreground transition-colors">
                    {rec}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
