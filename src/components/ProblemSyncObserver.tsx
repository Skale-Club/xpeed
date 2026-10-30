import { invalidateSessionLists } from '@/lib/db';
import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useObd } from '@/contexts/ObdScannerContext';
import { syncSavedProblems } from '@/lib/problem-sync';
export function ProblemSyncObserver() {
  const {user}=useAuth(); const {lastTrip}=useObd();
  useEffect(() => { if(lastTrip) invalidateSessionLists(); }, [lastTrip]);
  useEffect(()=>{
    if(!user?.id) return;
    let busy=false,stopped=false;
    const sync=async()=>{if(busy || stopped || navigator.onLine===false)return;busy=true;try{for(let batch=0;batch<3 && !stopped;batch++){const result=await syncSavedProblems();if(result.synced<10)break;}}catch{/* Durable server jobs stay queued. */}finally{busy=false;}};
    const visible=()=>{if(document.visibilityState==='visible')void sync();};
    void sync(); const timer=setInterval(visible,60000);
    window.addEventListener('online',visible);document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;clearInterval(timer);window.removeEventListener('online',visible);document.removeEventListener('visibilitychange',visible);};
  },[user?.id,lastTrip?.sessionId]);
  return null;
}
