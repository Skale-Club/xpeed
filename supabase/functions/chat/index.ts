import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createChatHandler } from "../_shared/chat-handler.ts";
serve(createChatHandler());
