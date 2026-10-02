const { key, variants } = require('./inbox-history');
const { replacementMeta, isMissingBookReplacement, replacementCovers } = require('./missing-books');
const user = m => ['user','customer'].includes(m.role);
const normal = s => String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
const ACK = /^(?:ok(?:ay)?[, ]*)?(?:thank(?:s| you)(?: so much)?|thx|got it|great|theek hai|shukriya|dhanyavad|👍|🙏)[.! ,🙏👍]*$/i;
const CONFIRMED = /^(?:thanks[,.! ]+|thank you[,.! ]+)?(?:the |my )?(?:(?:issue|problem|query) (?:is |has been )?(?:resolved|solved|fixed)|(?:received|got) (?:the |my )?(?:refund|missing book|replacement)|(?:refund|missing book|replacement) (?:has |is )?(?:been )?(?:received|arrived)|no (?:more|further) (?:issues|help needed))[.! ,]*(?:thanks|thank you)?[.! ]*$/i;
const NEGATIVE = /\b(?:not|never|still|waiting|pending|but|hasn.?t|haven.?t|didn.?t|nahi)\b/i;
const TOP = /\b(?:missing (?:book|item)s?|(?:book|item)s? (?:is |are |was |were )?missing|incomplete (?:order|parcel|set)|cancel(?:led|ed|lation)?|cancle|refund|paisa wapas|paise wapas|book nahi (?:mila|aayi)|kam (?:hai|mila))\b/i;
const TRACK = /\b(?:track(?:ing)?|where(?:'s| is) (?:my |the )?order|order kaha|kab (?:aayega|milega)|not (?:yet )?picked up|pickup|picked|dispatch|delivery|shipment|awb)\b/i;
const ATTENTION = /\b(?:human|agent|call me|support|fraud|scam|damaged|wrong book|angry|complaint|not helpful|no update)\b|\[ESCALATE\]/i;
function orderProblem(orders=[]) {
  for(const o of orders){
    const status=normal(o.status),meta=replacementMeta(o);
    const refunded=!!(meta?.refund_paid_at||meta?.refund_issued_at||status==='refunded');
    if(isMissingBookReplacement(o)&&!refunded&&status!=='delivered')
      return status==='cancelled'?'Missing-book replacement cancelled — verify outstanding refund':'Missing-book replacement still needs delivery';
    const missing=(Array.isArray(o.cart_items)?o.cart_items:[]).filter(i=>i._missing);
    if(missing.length){
      const resolved=orders.some(r=>replacementMeta(r)?.original_order_id===o.razorpay_order_id &&
        replacementCovers(r,missing)&&(replacementMeta(r)?.refund_paid_at||replacementMeta(r)?.refund_issued_at||normal(r.status)==='delivered'));
      if(!resolved&&status!=='refunded')return 'Reported missing books still need fulfilment or refund verification';
    }
    if(status==='cancelled'&&!refunded&&(!o.created_at||Date.now()-Date.parse(o.created_at)<30*86400000))return 'Cancelled order needs follow-up';
    if(['refund_pending','refund_failed'].includes(status))return 'Refund still pending or failed';
  }
  return '';
}
const isClosureCandidate = message => !NEGATIVE.test(normal(message)) && (ACK.test(normal(message)) || CONFIRMED.test(normal(message)));
function canAutoClose(conv,messages,orders=[]) {
  if(conv.human_takeover||orderProblem(orders))return false;
  const last=[...messages].reverse().find(user);if(!last)return false;
  const text=normal(last.message);if(NEGATIVE.test(text))return false;
  const prior=messages.slice(0,messages.indexOf(last));
  if(!['bot','assistant'].includes(prior.at(-1)?.role))return false;
  if(CONFIRMED.test(text))return true;
  // A thank-you alone never settles missing books, cancellation or money disputes.
  const history=prior.filter(user).map(m=>m.message).join(' ');
  return ACK.test(text)&&TRACK.test(history)&&!TOP.test(history)&&!ATTENTION.test(history);
}
function category(conv,messages=[],orders=[],now=Date.now()) {
  if(conv.status==='resolved')return {category:'closed',category_reason:'Conversation closed'};
  const problem=orderProblem(orders);
  const text=messages.filter(user).map(m=>m.message).join(' ') || (String(conv.last_message||'').startsWith('[Bot]:')?'':conv.last_message||'');
  if(problem||TOP.test(text))return {category:'top',category_reason:problem||'Missing book, cancellation or refund issue'};
  const last=messages[messages.length-1];
  const questions=messages.filter(user).map(m=>normal(m.message)).filter(t=>t.length>8);
  const repeats=questions.some(t=>questions.filter(q=>q===t).length>=3);
  if(conv.human_takeover||repeats||ATTENTION.test(text)|| (last&&user(last)&&now-Date.parse(last.created_at)>2*3600000))
    return {category:'attention',category_reason:conv.human_takeover?'Human handling required':'Needs a human response or follow-up'};
  if(TRACK.test(text))return {category:'low',category_reason:'Routine order tracking or pickup query'};
  return {category:'attention',category_reason:'Review this customer inquiry'};
}
async function contextFor(db,phone){
  const [messages,orders]=await Promise.all([
    db.from('bot_messages').select('role,message,created_at').in('customer_phone',variants(phone)).order('created_at',{ascending:false}).limit(80),
    db.from('orders').select('razorpay_order_id,status,cart_items,source,created_at').in('customer_phone',variants(phone)).order('created_at',{ascending:false}).limit(100),
  ]);
  if(messages.error||orders.error)throw messages.error||orders.error;
  // Don't auto-close if the history/order checks may be truncated.
  return {messages:(messages.data||[]).reverse(),orders:orders.data||[],complete:(messages.data||[]).length<80&&(orders.data||[]).length<100};
}
let cached;
async function categorizeConversations(db,convs){
  const signature=JSON.stringify(convs.map(c=>[c.customer_phone,c.last_message_at,c.status,c.human_takeover]));
  if(cached&&cached.signature===signature&&Date.now()-cached.at<60000)return convs.map(c=>({...c,...cached.categories.get(key(c.customer_phone))}));
  const phones=[...new Set(convs.flatMap(c=>variants(c.customer_phone)))];if(!phones.length)return convs;
  const messages=[],orders=[];
  for(const [table,fields,target] of [['bot_messages','customer_phone,role,message,created_at',messages],['orders','customer_phone,razorpay_order_id,status,cart_items,source,created_at',orders]]){
    for(let from=0;;from+=1000){
      let query=db.from(table).select(fields).in('customer_phone',phones);
      if(table==='bot_messages')query=query.gte('created_at',new Date(Date.now()-14*86400000).toISOString());
      const result=await query.order('created_at',{ascending:true}).order('id',{ascending:true}).range(from,from+999);
      if(result.error)return convs.map(c=>({...c,...(c.status==='resolved'?{category:'closed',category_reason:'Conversation closed'}:{category:'attention',category_reason:'Priority checks unavailable — review manually'})}));target.push(...(result.data||[]));if((result.data||[]).length<1000)break;
    }
  }
  const categories=new Map(convs.map(c=>[key(c.customer_phone),category(c,messages.filter(m=>key(m.customer_phone)===key(c.customer_phone)),orders.filter(o=>key(o.customer_phone)===key(c.customer_phone)))]));
  cached={signature,at:Date.now(),categories};return convs.map(c=>({...c,...categories.get(key(c.customer_phone))}));
}
module.exports={category,canAutoClose,contextFor,categorizeConversations,ACK,isClosureCandidate};
