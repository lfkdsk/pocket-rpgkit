// Build-time pixel recipes for the grow world's shared palette and small props.
// Ninja Adventure remains the source for cottages and tree silhouettes.
import { GROW_TILE as T } from './grow.ts';
export const TERRAIN_COLORS = [[145,163,112],[151,148,122],[193,179,139],[190,207,204]] as const;
type RGB = readonly number[];
export function terrainArt(biome: number): Uint8Array {
  const a = new Uint8Array(1024), base = TERRAIN_COLORS[biome]!;
  for(let y=0;y<16;y++)for(let x=0;x<16;x++){
    const shade = ((x*13+y*7+x*y)%47===0) ? -7 : ((x*3+y*11)%61===0) ? 5 : 0;
    const i=(y*16+x)*4; for(let c=0;c<3;c++)a[i+c]=base[c]!+shade;a[i+3]=255;
  }return a;
}
export function transitionArt(biome:number, stage:number):Uint8Array {
  const a=terrainArt(biome),b=terrainArt((biome+3)%4);
  for(let y=0;y<16;y++)for(let x=0;x<16;x++){
    // Three cells of broken, interlocking patches, not a straight border.
    const threshold=[12,8,3][stage]!;
    if(((Math.floor(x/3)*5+Math.floor(y/3)*7)%16)<threshold){const i=(y*16+x)*4;a.set(b.subarray(i,i+4),i);}
  }return a;
}
export function smallArt(cell:number, ground:boolean):Uint8Array|undefined {
  const a=new Uint8Array(1024);
  const px=(x:number,y:number,c:RGB)=>{if(x>=0&&y>=0&&x<16&&y<16)a.set([c[0]!,c[1]!,c[2]!,255],(y*16+x)*4);};
  const rect=(x:number,y:number,w:number,h:number,c:RGB)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)px(xx,yy,c);};
  const dark=[74,77,60],wood=[134,101,65],light=[192,161,107],leaf=[89,123,71],gold=[191,167,83],water=[102,158,167];
  if(ground){
    if(cell===T.BANK_L||cell===T.BANK_R){
      rect(0,0,16,16,TERRAIN_COLORS[0]!);
      for(let y=0;y<16;y++)for(let x=0;x<16;x++){
        const d=cell===T.BANK_L?15-x:x,edge=5+(Math.floor(y/4)%2)*2;
        if(d<edge)px(x,y,water);else if(d<edge+3)px(x,y,[176,170,126]);
      }
    }else if([T.WATER,T.OASIS].includes(cell as any)){rect(0,0,16,16,water);rect(2,4,5,1,[137,185,185]);rect(10,11,4,1,[137,185,185]);}
    else if([T.ROAD_H,T.ROAD_V,T.ROAD_CROSS,T.PLAZA,T.WORK_YARD,T.MARKET_RUG].includes(cell as any)){
      rect(0,0,16,16,[168,153,115]);for(const [x,y] of [[3,5],[11,12],[14,3]])rect(x!,y!,2,1,[154,139,103]);
      if(cell===T.MARKET_RUG){rect(1,1,14,14,[142,112,95]);rect(2,2,12,1,light);rect(2,13,12,1,light);}
    }else if(cell===T.WINTER_PLOT){rect(0,0,16,16,[157,162,138]);rect(0,6,16,1,[139,148,126]);rect(0,11,16,1,[139,148,126]);
    }else if([T.FARM_A,T.FARM_B].includes(cell as any)){
      rect(0,0,16,16,[129,112,81]);
      for(let y=2;y<16;y+=5){rect(0,y,16,2,[99,90,66]);for(let x=2;x<16;x+=5){rect(x,y-1,2,2,cell===T.WINTER_PLOT?light:leaf);px(x+1,y-2,cell===T.FARM_B?gold:leaf);}}
    }else if(cell===T.BRIDGE_H){rect(0,0,16,16,wood);for(let x=0;x<16;x+=4){rect(x,0,1,16,dark);rect(x+1,0,1,16,light);}rect(0,1,16,2,light);rect(0,13,16,2,dark);}
    else return undefined;
    return a;
  }
  switch(cell){
    case T.FENCE_H:case T.BRIDGE_RAIL:
      rect(0,5,16,2,light);rect(0,10,16,2,wood);for(const x of [2,12]){rect(x,3,2,11,dark);rect(x,3,1,10,light);}break;
    case T.FENCE_V:
      rect(7,0,2,16,wood);for(const y of [2,11]){rect(5,y,5,3,dark);rect(5,y,4,2,light);}break;
    case T.LOGS:case T.FIREWOOD:
      for(const [x,y,w] of [[2,10,12],[1,6,11],[4,3,10]]){rect(x!,y!,w!,4,dark);rect(x!+1,y!,w!-2,2,wood);rect(x!,y!,3,3,light);px(x!+1,y!+1,wood);}break;
    case T.WELL:
      rect(2,7,12,7,dark);rect(3,8,10,5,[161,161,133]);rect(5,7,6,3,water);rect(2,3,2,8,wood);rect(12,3,2,8,wood);rect(2,2,12,2,light);break;
    case T.NOTICE:
      rect(7,8,2,7,wood);rect(3,2,10,8,dark);rect(4,3,8,6,light);rect(6,5,4,1,wood);break;
    case T.STALL:
      rect(2,4,2,11,wood);rect(12,4,2,11,wood);rect(1,10,14,4,light);rect(0,2,16,5,[127,153,134]);for(let x=0;x<16;x+=4)rect(x,2,2,5,[215,195,148]);rect(4,9,3,2,gold);rect(9,9,3,2,leaf);break;
    case T.ROCK:
      rect(4,9,9,4,[102,113,108]);rect(3,7,9,4,[146,153,134]);rect(5,6,5,2,[180,181,153]);break;
    case T.BUSH:case T.SNOW_SHRUB:
      rect(3,9,10,4,dark);rect(2,7,11,4,cell===T.BUSH?leaf:[147,171,161]);rect(5,5,6,4,cell===T.BUSH?[112,146,81]:[190,207,204]);break;
    case T.GRASS_TUFT:
      for(const [x,y] of [[4,9],[7,7],[10,10]]){rect(x!,y!,1,5,leaf);px(x!-1,y!-1,leaf);}break;
    case T.FLOWER_PROP:
      for(const [x,y] of [[4,8],[9,10],[11,5]]){rect(x!,y!,1,4,leaf);rect(x!-1,y!-1,3,2,[211,193,144]);px(x!,y!,[167,132,86]);}break;
    case T.CACTUS:
      rect(7,3,3,11,leaf);rect(3,7,5,2,leaf);rect(3,4,2,4,leaf);rect(10,6,3,2,leaf);rect(12,3,2,5,leaf);break;
    case T.PALM:case T.FIR:case T.TREE:
      rect(7,7,2,8,wood);rect(2,4,12,5,leaf);rect(5,2,7,3,[112,146,81]);break;
    default:return undefined;
  }return a;
}

/** Whole palm/fir silhouettes split into six tiles after drawing. */
export function climateTree(cell:number):Uint8Array|undefined {
  if(cell<58||cell>=70)return undefined;
  const snowy=cell>=64,part=(cell-58)%6,a=new Uint8Array(32*48*4);
  const dot=(x:number,y:number,c:RGB)=>{if(x>=0&&x<32&&y>=0&&y<48)a.set([c[0]!,c[1]!,c[2]!,255],(y*32+x)*4);};
  for(let y=38;y<43;y++)for(let x=7;x<26;x++)if(((x-16)/10)**2+((y-40)/3)**2<1)dot(x,y,[110,124,100]);
  for(let y=19;y<41;y++)for(let x=15;x<19;x++)dot(x+(snowy?0:Math.floor((40-y)/10)),y,[121,102,72]);
  if(snowy){
    for(const [top,bottom,half] of [[3,19,8],[11,28,11],[19,36,14]])for(let y=top!;y<bottom!;y++){
      const w=Math.floor((y-top!)/(bottom!-top!)*half!);
      for(let x=16-w;x<=16+w;x++)dot(x,y,(y-top!)%8<3?[209,222,212]:x<16?[104,137,119]:[77,113,99]);
    }
  }else{
    for(let leaf=0;leaf<7;leaf++){
      const angle=leaf*Math.PI/3.5;
      for(let t=0;t<14;t++){const x=Math.round(17+Math.cos(angle)*t),y=Math.round(12+Math.sin(angle)*t*.6+t*t*.018);
        for(let d=-2;d<=2;d++)dot(x,y+d,leaf%2?[104,132,75]:[128,150,88]);}
    }
  }
  const out=new Uint8Array(1024),ox=part%2*16,oy=Math.floor(part/2)*16;
  for(let y=0;y<16;y++)out.set(a.subarray(((oy+y)*32+ox)*4,((oy+y)*32+ox+16)*4),y*64);
  return out;
}

// Causal world: worn trails, paved road, quarry/ruin floor, collapsed homes.
const hh=(x:number,y:number,s:number)=>{let h=(Math.imul(x,374761393)+Math.imul(y,668265263)+Math.imul(s,0x27d4eb2f))>>>0;
  h=Math.imul(h^(h>>>13),1274126177);return (h^(h>>>16))>>>0;};
/** Earth showing through feet-worn floor, per biome: [earth, footprint]. */
export const WORN_COLORS = [[[163,150,108],[139,128,92]],[[166,143,103],[132,116,86]],[[171,153,110],[150,133,96]],[[163,158,138],[139,136,120]]] as const;
export const PATH_STONE_COLORS = { stone:[150,148,138], light:[174,172,160], shade:[126,124,114], mortar:[94,92,82] } as const;
export const GRAVEL_COLOR = [116,108,94] as const;
export function causalArt(cell:number):Uint8Array|undefined {
  const a=new Uint8Array(1024);
  const px=(x:number,y:number,c:RGB)=>{if(x>=0&&y>=0&&x<16&&y<16)a.set([c[0]!,c[1]!,c[2]!,255],(y*16+x)*4);};
  const rect=(x:number,y:number,w:number,h:number,c:RGB)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)px(xx,yy,c);};
  const S=PATH_STONE_COLORS,dark=[74,77,60],stone=[176,170,150],slight=[202,196,174],sdark=[120,114,100],
    char=[66,56,46],wood=[112,88,62];
  if(cell>=T.WORN_GRASS&&cell<=T.WORN_SNOW){
    // Wrapping 4px value noise thresholded at ~37% (plus speckles, ~42% total) gives seamless trodden blotches.
    const b=cell-T.WORN_GRASS,[earth,step]=WORN_COLORS[b]!,v=new Int32Array(256);
    a.set(terrainArt(b));
    const k=(x:number,y:number)=>hh(x&3,y&3,b*7+1)&255;
    for(let y=0;y<16;y++)for(let x=0;x<16;x++){
      const cx=x>>2,cy=y>>2,fx=(x&3)/4,fy=(y&3)/4;
      v[y*16+x]=Math.round((k(cx,cy)*(1-fx)+k(cx+1,cy)*fx)*(1-fy)+(k(cx,cy+1)*(1-fx)+k(cx+1,cy+1)*fx)*fy)+(hh(x,y,b+9)&63);
    }
    const cut=[...v].sort((p,q)=>q-p)[Math.round(256*0.37)]!;
    for(let i=0;i<256;i++){const x=i&15,y=i>>4;
      if(v[i]!>cut)px(x,y,(hh(x,y,b+3)%11===0)?step:earth);
      else if(hh(x,y,b+5)%23===0)px(x,y,earth);
    }
    // Paired footprint dents along the trail.
    for(const [x,y] of [[3,2],[10,6],[5,10],[12,13]])if(v[y!*16+x!]!>cut-24){px(x!,y!,step);px(x!+1,y!,step);px(x!+2,y!+1,step);}
    return a;
  }
  if(cell===T.PATH_STONE){
    // Staggered flagstones in four 4px courses; mortar wraps at tile edges.
    rect(0,0,16,16,S.mortar);
    for(let row=0;row<4;row++){
      const off=[0,3,6,1][row]!,widths=[[5,6,5],[6,4,6],[4,7,5],[6,5,5]][row]!;let x0=off;
      for(const w of widths){
        for(let yy=0;yy<3;yy++)for(let xx=0;xx<w-1;xx++){
          const x=(x0+xx)&15,y=row*4+yy,edge=xx===0||yy===0?S.light:xx===w-2||yy===2?S.shade:S.stone;
          px(x,y,hh(x,y,31)%17===0?S.shade:edge);
        }
        x0+=w;
      }
    }
    return a;
  }
  if(cell===T.GRAVEL){
    rect(0,0,16,16,GRAVEL_COLOR);
    for(let y=0;y<16;y++)for(let x=0;x<16;x++){const h=hh(x,y,41)%11;if(h===0)px(x,y,[100,93,81]);else if(h===1)px(x,y,[134,126,111]);}
    for(let i=0;i<10;i++){const h=hh(i,5,43),x=h&15,y=(h>>4)&15,w=1+((h>>8)&1);
      rect(x,y,w,1,[140,132,116]);px(x,y,[154,146,129]);rect(x,(y+1)&15,w,1,[92,86,75]);}
    return a;
  }
  // Big staggered blocks under a column silhouette: dark outline, lit tops.
  const masonry=(top:number[])=>{const at=(x:number,y:number)=>x>=0&&x<16&&y>=top[x]!;
    for(let x=0;x<16;x++)for(let y=top[x]!;y<16;y++){
      const r=Math.floor(y/3),n=4+hh(r,0,62)%3,mortar=y%3===2||(x+hh(r,1,63))%n===n-1;
      px(x,y,!at(x-1,y)||!at(x+1,y)?dark:y===top[x]?slight:mortar?sdark:hh(x>>1,r,61)%5===0?[160,153,134]:stone);
      if(y===top[x]&&y>0)px(x,y-1,dark);}};
  if(cell===T.RUIN_L||cell===T.RUIN_M||cell===T.RUIN_R){
    // Collapsed walls: a corner pier (L/R) and low stepped wall stubs with a
    // breach; floor shows through, a charred beam or post is left standing.
    const L=cell!==T.RUIN_R,top=new Array<number>(16).fill(16);
    if(cell===T.RUIN_M){
      const t=[10,9,7,7,8,11,14,16,16,15,12,10,10,9,9,10];
      t.forEach((v,x)=>top[x]=v);masonry(top);
      for(let y=3;y<10;y++){px(12,y,y<4?dark:char);px(13,y,y<5?char:wood);}
      for(let i=0;i<5;i++){px(3+i,6-(i>>1),char);px(3+i,7-(i>>1),wood);}
    }else{
      const t=[0,0,0,0,0,4,4,6,7,7,9,10,10,12,11,10];
      t.forEach((v,d)=>top[L?d:15-d]=v);masonry(top);
      for(let i=0;i<6;i++){const x=L?7+i:8-i;px(x,i+1,char);px(L?x+1:x-1,i+1,wood);}
    }
    return a;
  }
  if(cell===T.RUBBLE){
    // A low mound of fallen blocks with two charred roof beams poking out.
    for(let i=0;i<9;i++){px(1+i,3+i,char);px(2+i,3+i,wood);}
    for(let i=0;i<5;i++){px(14-i,5+i,char);px(13-i,5+i,[138,112,80]);}
    const t=[14,12,11,10,10,9,9,8,9,9,9,10,10,11,12,14];
    masonry(t);
    for(const [x,y] of [[3,12],[9,11],[6,14],[12,13]]){rect(x!,y!,3,2,stone);rect(x!,y!,3,1,slight);px(x!+2,y!+1,sdark);px(x!-1,y!+1,dark);}
    return a;
  }
  return undefined;
}

/** A small covered trade cart with a canvas hood and a shaft, facing right. */
export function caravanArt():Uint8Array {
  const a=new Uint8Array(1024);
  const px=(x:number,y:number,c:RGB)=>{if(x>=0&&y>=0&&x<16&&y<16)a.set([c[0]!,c[1]!,c[2]!,255],(y*16+x)*4);};
  const rect=(x:number,y:number,w:number,h:number,c:RGB)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)px(xx,yy,c);};
  const dark=[74,77,60],wood=[134,101,65],light=[192,161,107],canvas=[214,203,170],cshade=[176,164,132],gold=[191,167,83];
  // Canvas hood with hoops, plank bed, sacks up front, spoked wheel, shaft.
  const sack=[176,146,98];
  const rows=["...kkkkkkk......","..kcccccccck....",".kcsccscccsck...",".kcsccscccsck...",
    ".kcsccscccskkk..",".kcsccscccskbbk.",".kssssssssskgbbk","kllllllllllllk..","kwwwwwwwwwwwwkww","kkkkkkkkkkkkkkkk"];
  const pal:Record<string,RGB>={k:dark,c:canvas,s:cshade,l:light,w:wood,g:gold,b:sack};
  rows.forEach((r,y)=>{for(let x=0;x<16;x++)if(r[x]!=='.')px(x,y+2,pal[r[x]!]!);});
  for(let y=9;y<16;y++)for(let x=1;x<10;x++){const d=Math.hypot(x-5,y-12);
    if(d<3.6)px(x,y,d>2.6?dark:d<1?dark:(x===5||y===12)?light:wood);}
  return a;
}
