export const legends = {
  dwd_satellite_infrared: `
        <div style="background: linear-gradient(to right,
            rgb(255, 204, 255),
            rgb(255, 143, 255), 
            rgb(255, 0, 255),
            rgb(190, 0, 255), 
            rgb(126, 0, 255),
            rgb(126, 0, 255),
            rgb(64, 0, 0), 
            rgb(191, 0, 0), 
            rgb(255, 0, 0), 
            rgb(250, 63, 0), 
            rgb(255, 192, 0), 
            rgb(254, 255, 0),
            rgb(34, 255, 0), 
            rgb(0, 253, 255), 
            rgb(0, 121, 255), 
            rgb(0, 65, 255),
            rgb(0, 0, 255),
            rgb(153, 153, 153),
            rgb(114, 114, 114),
            rgb(96, 96, 96),
            rgb(80, 80, 80),
            rgb(59, 59, 59),
            rgb(32, 32, 32),
            rgb(16, 16, 16),
            rgb(12, 12, 12),
            rgb(12, 12, 12)); 
            color: white; width: 100%; height: 20px; 
            display: flex; align-items: center; 
            justify-content: space-between; 
            border-radius: 4px;">
            <span style="color: rgb(0, 0, 0);"> -84</span>
            <span class="hoss">-76</span>
            <span class="hoss">-68</span>
            <span class="hoss">-60</span>
            <span class="hoss">-52</span>
            <span class="hoss">-44</span>
            <span style="color: rgb(0, 0, 0);">-36</span>
            <span style="color: rgb(0, 0, 0);">-28</span>
            <span style="color: rgb(0, 0, 0);">-20</span>
            <span class="hoss">-12</span>
            <span class="hoss">-4</span>
            <span class="hoss">4</span>
            <span class="hoss">12</span>
            <span class="hoss">20</span>
            <span class="hoss">28</span>
            <span class="hoss">36</span>
            <span class="hoss">44</span>
            <span class="hoss">40</span>
        </div>
    `,
  rainviewerSatInfra: `
    <div style="background: linear-gradient(to right, #565B54, #7B7C7B, #A3A3A3, #C8C8C8, #EAEAEA, #F5F5F5); 
      color: white; text-shadow: 1px 1px 0 #000000, -1px -1px 0 #000000, 1px -1px 0 #000000, -1px 1px 0 #000000; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border-radius: 4px;">
      <span>Clouds</span>
    </div>`,
  rainviewerRadar: `
    <div style="background: linear-gradient(to right, #63eb63 0%, #3dc63d 10%, #1f9e34 20%, #116719 30%, #023002 48%, #023002 50%, #ff0 50%, #ff7f00 60%, #e60000 70%, #cd0000 80%, #9b0000 90%, #820000 100%); 
      color: black; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; border-radius: 4px;">
      <span></span>
    </div>`,
  gdpsRelHum: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="1" class="bar1" style="background-color: #FFFFFF; width: 5vw;"><span>0</span></div>
        <div id="2" class="bar1" style="background-color: #0010CC; width: 5vw;"><span>5</span></div>
        <div id="4" class="bar1" style="background-color: #0031FE; width: 5vw;"><span>10</span></div>
        <div id="5" class="bar1" style="background-color: #00B3FE; width: 5vw;"><span>20</span></div>
        <div id="6" class="bar1" style="background-color: #28FDD4; width: 5vw;"><span>30</span></div>
        <div id="7" class="bar1" style="background-color: #90FD6D; width: 5vw;"><span>40</span></div>
        <div id="8" class="bar1" style="background-color: #F6FE05; width: 5.2vw;"><span>50</span></div>
        <div id="9" class="bar1" style="background-color: #FEA300; width: 5.2vw;"><span>60</span></div>
        <div id="10" class="bar1" style="background-color:#FE3B00; width: 5.2vw;"><span>70</span></div>
        <div id="11" class="bar1" style="background-color:#DC0000; width: 5.2vw;"><span>80</span></div>
        <div id="12" class="bar1" style="background-color:#B10000; width: 5.2vw;"><span>90</span></div>
        <div id="13" class="bar1" style="background-color:#830000; width: 5.2vw;"><span>100</span></div>
        <div id="14" class="bar1" style="background-color:#490000; width: 5.2vw;"><span>120</span></div>
        <div id="15" class="bar1" style="width:0vw"><span>150</span></div>
    </div>`,
  gdpsSpecificHum: `
        <div style="display: flex;  align-items: center; flex-wrap: wrap;">
            <div id="1" class="bar2" style="background-color: #001AB4;"><span>Very Low</span></div>
            <div id="2" class="bar2" style="background-color: #1AA3E3;"><span>Low</span></div>
            <div id="3" class="bar2" style="background-color: #B4FE4B;"><span>Moderate</span></div>
            <div id="4" class="bar2" style="background-color: #FE7201;"><span>High</span></div>
            <div id="5" class="bar2" style="background-color: #AD1300;"><span>Very High</span></div>
        </div>`,
  gdpsAccPreci: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #FFFFFF;"><span>0</span></div>
        <div id="p2" class="bar1" style="background-color: #B8D5FF;"><span>1</span></div>
        <div id="p3" class="bar1" style="background-color: #A1C7FF;"><span>2</span></div>
        <div id="p4" class="bar1" style="background-color: #A6CBFF;"><span>5</span></div>
        <div id="p5" class="bar1" style="background-color: #7AACFF;"><span>10</span></div>
        <div id="p6" class="bar1" style="background-color: #3DA0F3;"><span>20</span></div>
        <div id="p7" class="bar1" style="background-color: #1FCADF;"><span>30</span></div>
        <div id="p8" class="bar1" style="background-color: #27E4D5;"><span>40</span></div>
        <div id="p9" class="bar1" style="background-color: #36F0C6;"><span>50</span></div>
        <div id="p10" class="bar1" style="background-color:#62FF9B;"><span>60</span></div>
        <div id="p11" class="bar1" style="background-color:#CCFE32;"><span>70</span></div>
        <div id="p12" class="bar1" style="background-color:#FFE900;"><span>80</span></div>
        <div id="p13" class="bar1" style="background-color:#FF9600;"><span>90</span></div>
        <div id="p14" class="bar1" style="background-color:#F71D00;"><span>100</span></div>
        <div id="p15" class="bar1" style="background-color:#D70000;"><span>120</span></div>
        <div id="p16" class="bar1" style="background-color:#280000;"><span>150</span></div>
        <div id="p20" class="bar1" style="flex: 0;"><span>kg/m²</span></div>
    </div>`,
  gdpsPreciTypes: `
        <div style="display: flex;  align-items: center; flex-wrap: wrap;">
            <div id="1" class="bar2" style="background-color: #007700;"><span>Rain</span></div>
            <div id="2" class="bar2" style="background-color: #EECC00;"><span>Rain-Snow</span></div>
            <div id="3" class="bar2" style="background-color: #FF0000;"><span>Freezing Rain</span></div>
            <div id="4" class="bar2" style="background-color: #FF06FF;"><span>Ice-Pellets</span></div>
            <div id="5" class="bar2" style="background-color: #005599;"><span>Snow</span></div>
        </div>`,
  ecmwfTemp: `
        <div style="display: flex;  align-items: center; flex-wrap: wrap;">
            <div id="p1" class="bar1" style="background-color: #e133e1; width:2.6vw;"><span>-52</span></div>
            <div id="p2" class="bar1" style="background-color: #ae33ae; width:2.6vw;"><span class="hoss">-48</span></div>
            <div id="p3" class="bar1" style="background-color: #7a337a; width:2.6vw;"><span>-44</span></div>
            <div id="p4" class="bar1" style="background-color: #473347; width:2.6vw;"><span class="hoss">-40</span></div>
            <div id="p5" class="bar1" style="background-color: #330066; width:2.6vw;"><span>-36</span></div>
            <div id="p6" class="bar1" style="background-color: #590080; width:2.6vw;"><span class="hoss">-32</span></div>
            <div id="p7" class="bar1" style="background-color: #8000ff; width:2.6vw;"><span>-28</span></div>
            <div id="p8" class="bar1" style="background-color: #0080ff; width:2.6vw;"><span class="hoss">-24</span></div>
            <div id="p9" class="bar1" style="background-color: #00ccff; width:2.6vw;"><span>-20</span></div>
            <div id="p10" class="bar1" style="background-color: #00ffff; width:2.6vw;"><span class="hoss">-16</span></div>
            <div id="p11" class="bar1" style="background-color: #00ff80; width:2.6vw;"><span>-12</span></div>
            <div id="p12" class="bar1" style="background-color: #80ff00; width:2.6vw;"><span class="hoss">-8</span></div>
            <div id="p13" class="bar1" style="background-color: #daff00; width:2.6vw;"><span>-4</span></div>
            <div id="p14" class="bar1" style="background-color: #ffff80; width:2.6vw;"><span class="hoss">0</span></div>
            <div id="p15" class="bar1" style="background-color: #ffff00; width:2.6vw;"><span>4</span></div>
            <div id="p16" class="bar1" style="background-color: #ffda00; width:2.6vw;"><span class="hoss">8</span></div>
            <div id="p17" class="bar1" style="background-color: #ffb000; width:2.6vw;"><span>12</span></div>
            <div id="p18" class="bar1" style="background-color: #ff7300; width:2.6vw;"><span class="hoss">16</span></div>
            <div id="p19" class="bar1" style="background-color: #ff0000; width:2.6vw;"><span>20</span></div>
            <div id="p20" class="bar1" style="background-color: #cc0000; width:2.6vw;"><span class="hoss">24</span></div>
            <div id="p21" class="bar1" style="background-color: #80002c; width:2.6vw;"><span>28</span></div>
            <div id="p22" class="bar1" style="background-color: #cc3d6e; width:2.6vw;"><span class="hoss">32</span></div>
            <div id="p23" class="bar1" style="background-color: #ff00ff; width:2.6vw;"><span>36</span></div>
            <div id="p24" class="bar1" style="background-color: #ff80ff; width:2.6vw;"><span class="hoss">40</span></div>
            <div id="p25" class="bar1" style="background-color: #ffbfff; width:2.6vw;"><span>44</span></div>
            <div id="p25" class="bar1" style=" width:0vw;"><span>48</span></div>
        </div>`,
  imergPrecipRateLayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div id="imerg_p3" class="bar1" style="background-color: rgba(56,160,58,1.0); width: 4vw;"><span>0.2</span></div>
        <div id="imerg_p5" class="bar1" style="background-color: rgba(141,198,63,1.0); width: 4vw;"><span>0.5</span></div>
        <div id="imerg_p6" class="bar1" style="background-color: rgba(193,219,80,1.0); width: 4vw;"><span>0.75</span></div>
        <div id="imerg_p7" class="bar1" style="background-color: rgba(245,240,98,1.0); width: 4vw;"><span>1.0</span></div>
        <div id="imerg_p8" class="bar1" style="background-color: rgba(245,203,66,1.0); width: 4vw;"><span>1.5</span></div>
        <div id="imerg_p9" class="bar1" style="background-color: rgba(245,166,35,1.0); width: 4vw;"><span>2.0</span></div>
        <div id="imerg_p10" class="bar1" style="background-color: rgba(239,117,44,1.0); width: 4vw;"><span>3.0</span></div>
        <div id="imerg_p11" class="bar1" style="background-color: rgba(234,68,53,1.0); width: 4vw;"><span>5.0</span></div>
        <div id="imerg_p12" class="bar1" style="background-color: rgba(208,48,40,1.0); width: 4vw;"><span>7.0</span></div>
        <div id="imerg_p13" class="bar1" style="background-color: rgba(183,28,28,1.0); width: 4vw;"><span>10.0</span></div>
        <div id="imerg_p14" class="bar1" style="background-color: rgba(151,25,25,1.0); width: 4vw;"><span>15.0</span></div>
        <div id="imerg_p15" class="bar1" style="background-color: rgba(120,23,23,1.0); width: 4vw;"><span>20.0</span></div>
        <div id="imerg_p16" class="bar1" style="background-color: rgba(93,16,16,1.0); width: 4vw;"><span>30.0</span></div>
        <div id="imerg_p17" class="bar1" style="background-color: rgba(66,9,9,1.0); width: 4vw;"><span>≥ 53.0</span></div>
    </div>
`,
  ecmwf_lightning: `
    <div style="display: flex; align-items: center; flex-wrap: wrap; width: 100%;">
        <div style="
            background: linear-gradient(to right, #87ff89, #feff59, #fcb12d, #f65319, #b10a0a, #270522);
            width: 100%; 
            height: 30px; 
            display: flex; 
            align-items: center; 
            justify-content: space-between; 
            border-radius: 4px; 
            padding: 5px;
        ">
            <span style="color: black; flex: 1; text-align: center;">Very Low</span>
            <span style="color: black; flex: 1; text-align: center;" class="hoss">Low</span>
            <span style="color: white; flex: 1; text-align: center;">Moderate</span>
            <span style="color: white; flex: 1; text-align: center;" class="hoss">High</span>
            <span style="color: white; flex: 1; text-align: center;">Very High</span>
        </div>
    </div>`,
  ecmwfCyclone: `
        <div style="display: flex;  align-items: center; flex-wrap: wrap;">
            <div id="1" class="bar1" style="background-color: #FF06FF; width:6vw;"><span>5</span></div>
            <div id="2" class="bar1" style="background-color: #FF4F01; width:6vw;"><span>10</span></div>
            <div id="3" class="bar1" style="background-color: #FFB000; width:6vw;"><span>20</span></div>
            <div id="4" class="bar1" style="background-color: #FFFE03; width:6vw;"><span>30</span></div>
            <div id="5" class="bar1" style="background-color: #26FF03; width:6vw;"><span>40</span></div>
            <div id="6" class="bar1" style="background-color: #018C30; width:6vw;"><span>50</span></div>
            <div id="7" class="bar1" style="background-color: #00FFFF; width:6vw;"><span>60</span></div>
            <div id="8" class="bar1" style="background-color: #0080FF; width:6vw;"><span>70</span></div>
            <div id="9" class="bar1" style="background-color: #0017FF; width:6vw;"><span>80</span></div>
            <div id="10" class="bar1" style="background-color: #7B11B3; width:6vw;"><span>90</span></div>
            <div id="11" class="bar1" style="flex: 0;"><span>100</span></div>
            <div id="11" class="bar1" style="flex: 0;"><span></span></div>
        </div>`,
  particulate_matter_25: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #ffffff; width:5.5vw"><span>0</span></div>
        <div id="p2" class="bar1" style="background-color: #ecfac5; width:5.5vw"><span>20</span></div>
        <div id="p3" class="bar1" style="background-color: #ceffcf; width:5.5vw"><span>30</span></div>
        <div id="p4" class="bar1" style="background-color: #9df0b4; width:5.5vw"><span>40</span></div>
        <div id="p5" class="bar1" style="background-color: #5abd9f; width:5.5vw"><span>50</span></div>
        <div id="p6" class="bar1" style="background-color: #3da695; width:5.5vw"><span>60</span></div>
        <div id="p7" class="bar1" style="background-color: #3c94b2; width:5.5vw"><span>80</span></div>
        <div id="p8" class="bar1" style="background-color: #1a6ead; width:5.5vw"><span>100</span></div>
        <div id="p9" class="bar1" style="background-color: #124e89; width:5.5vw"><span>150</span></div>
        <div id="p10" class="bar1" style="background-color: #121b92; width:5.5vw"><span>200</span></div>
        <div id="p11" class="bar1" style="background-color: #2b0043; width:5.5vw"><span>300</span></div>
        <div id="p12" class="bar1" style="flex:0;"><span>500</span></div>
    </div>`,
  particulate_matter_10: `
        <div style="display: flex;  align-items: center; flex-wrap: wrap;">
            <div id="p1" class="bar1" style="background-color: #c6e9f3; width:5vw"><span>0</span></div>
            <div id="p2" class="bar1" style="background-color: #b3dfeb; width:5vw"><span>2</span></div>
            <div id="p3" class="bar1" style="background-color: #a0d5e3; width:5vw"><span>5</span></div>
            <div id="p4" class="bar1" style="background-color: #bfdfcd; width:5vw"><span>10</span></div>
            <div id="p5" class="bar1" style="background-color: #ebeeb3; width:5vw"><span>20</span></div>
            <div id="p6" class="bar1" style="background-color: #fae88e; width:5vw"><span>30</span></div>
            <div id="p7" class="bar1" style="background-color: #f5d363; width:5vw"><span>40</span></div>
            <div id="p8" class="bar1" style="background-color: #edb43d; width:5vw"><span>50</span></div>
            <div id="p9" class="bar1" style="background-color: #e18621; width:5vw"><span>75</span></div>
            <div id="p10" class="bar1" style="background-color: #d05d0c; width:5vw"><span>100</span></div>
            <div id="p11" class="bar1" style="background-color: #aa4211; width:5vw"><span>150</span></div>
            <div id="p12" class="bar1" style="background-color: #852716; width:5vw"><span>200</span></div>
            <div id="p13" class="bar1" style="flex: 0;"><span>500</span></div>
    </div>`,
  nitrogen_dioxide_850hPa: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #265ba0; width:5.5vw"><span>0.01</span></div>
        <div id="p2" class="bar1" style="background-color: #269170; width:5.5vw"><span>0.02</span></div>
        <div id="p3" class="bar1" style="background-color: #6bb25b; width:5.5vw"><span>0.05</span></div>
        <div id="p4" class="bar1" style="background-color: #a8c96b; width:5.5vw"><span>0.1</span></div>
        <div id="p5" class="bar1" style="background-color: #fff49b; width:5.5vw"><span>0.2</span></div>
        <div id="p6" class="bar1" style="background-color: #f4d138; width:5.5vw"><span>0.5</span></div>
        <div id="p7" class="bar1" style="background-color: #eab538; width:5.5vw"><span>1</span></div>
        <div id="p8" class="bar1" style="background-color: #dd8740; width:5.5vw"><span>2</span></div>
        <div id="p9" class="bar1" style="background-color: #cc3533; width:5.5vw"><span>5</span></div>
        <div id="p10" class="bar1" style="background-color: #9b1623; width:5.5vw"><span>10</span></div>
        <div id="p11" class="bar1" style="background-color: #561919; width:5.5vw"><span>20</span></div>
        <div id="p12" class="bar1" style="background-color: #341919; width:5.5vw"><span>50</span></div>
        <div id="p13" class="bar1" style="flex: 0;"><span>3</span></div>
    </div>`,
  sulphur_dioxide_850hPa: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #c6e9f3; width:  5vw"><span>0</span></div>
        <div id="p2" class="bar1" style="background-color: #b3dfeb; width:  5vw"><span>2</span></div>
        <div id="p3" class="bar1" style="background-color: #a0d5e3; width:  5vw"><span>5</span></div>
        <div id="p4" class="bar1" style="background-color: #bfdfcd; width:  5vw"><span>10</span></div>
        <div id="p5" class="bar1" style="background-color: #ebeeb3; width:  5vw"><span>20</span></div>
        <div id="p6" class="bar1" style="background-color: #fae88e; width:  5vw"><span>30</span></div>
        <div id="p7" class="bar1" style="background-color: #f5d363; width:  5vw"><span>40</span></div>
        <div id="p8" class="bar1" style="background-color: #edb43d; width:  5vw"><span>50</span></div>
        <div id="p9" class="bar1" style="background-color: #e18621; width:  5vw"><span>75</span></div>
        <div id="p10" class="bar1" style="background-color: #d05d0c; width:  5vw"><span>100</span></div>
        <div id="p11" class="bar1" style="background-color: #aa4211; width:  5vw"><span>150</span></div>
        <div id="p12" class="bar1" style="background-color: #852716; width:  5vw"><span>200</span></div>
        <div id="p13" class="bar1" style="flex: 0;"><span>800</span></div>
    </div>`,
  ozone: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #c6e9f3; width:5.5vw"><span>0</span></div>
        <div id="p2" class="bar1" style="background-color: #b3dfeb; width:5.5vw"><span>20</span></div>
        <div id="p3" class="bar1" style="background-color: #a0d5e3; width:5.5vw"><span>40</span></div>
        <div id="p4" class="bar1" style="background-color: #bfdfcd; width:5.5vw"><span>60</span></div>
        <div id="p5" class="bar1" style="background-color: #ebeeb3; width:5.5vw"><span>80</span></div>
        <div id="p6" class="bar1" style="background-color: #fae88e; width:5.5vw"><span>100</span></div>
        <div id="p7" class="bar1" style="background-color: #f5d363; width:5.5vw"><span>120</span></div>
        <div id="p8" class="bar1" style="background-color: #edb43d; width:5.5vw"><span>140</span></div>
        <div id="p9" class="bar1" style="background-color: #e18621; width:5.5vw"><span>160</span></div>
        <div id="p10" class="bar1" style="background-color: #d05d0c; width:5.5vw"><span>180</span></div>
        <div id="p11" class="bar1" style="background-color: #aa4211; width:5.5vw"><span>200</span></div>
        <div id="p12" class="bar1" style="background-color:#852716; width:3.5vw"><span>240</span></div>
        <div id="p13" class="bar1" style="flex: 0;"><span>500</span></div>
    </div>`,
  carbon_monoxide: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #c6e9f3; width:5.2vw"><span>0</span></div>
        <div id="p2" class="bar1" style="background-color: #b3dfeb; width:5.2vw"><span>50</span></div>
        <div id="p3" class="bar1" style="background-color: #a0d5e3; width:5.2vw"><span>100</span></div>
        <div id="p4" class="bar1" style="background-color: #bfdfcd; width:5.2vw"><span>150</span></div>
        <div id="p5" class="bar1" style="background-color: #ebeeb3; width:5.2vw"><span>200</span></div>
        <div id="p6" class="bar1" style="background-color: #fae88e; width:5.2vw"><span>250</span></div>
        <div id="p7" class="bar1" style="background-color: #f5d363; width:5.2vw"><span>300</span></div>
        <div id="p8" class="bar1" style="background-color: #edb43d; width:5.2vw"><span>350</span></div>
        <div id="p9" class="bar1" style="background-color: #e18621; width:5.2vw"><span>400</span></div>
        <div id="p10" class="bar1" style="background-color: #d05d0c; width:5.2vw"><span>500</span></div>
        <div id="p11" class="bar1" style="background-color: #aa4211; width:5.2vw"><span>700</span></div>
        <div id="p12" class="bar1" style="background-color: #852716; width:5.2vw"><span>1000</span></div>
        <div id="p12" class="bar1"><span>1200</span></div>
    </div>`,
  dust: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #FFFFFE; width:6vw"><span>0.1</span></div>
        <div id="p2" class="bar1" style="background-color: #FEF7F0; width:6vw"><span>0.15</span></div>
        <div id="p3" class="bar1" style="background-color: #FDE5D0; width:6vw"><span>0.2</span></div>
        <div id="p4" class="bar1" style="background-color: #FCD2B1; width:6vw"><span>0.25</span></div>
        <div id="p5" class="bar1" style="background-color: #FABA8F; width:6vw"><span>0.3</span></div>
        <div id="p6" class="bar1" style="background-color: #F09A67; width:6vw"><span>0.35</span></div>
        <div id="p7" class="bar1" style="background-color: #DF7747; width:6vw"><span>0.4</span></div>
        <div id="p8" class="bar1" style="background-color: #CD6839; width:6vw"><span>0.5</span></div>
        <div id="p9" class="bar1" style="background-color: #913815; width:6vw"><span>0.8</span></div>
        <div id="p10" class="bar1" style="background-color: #7D290B; width:6vw"><span>1</span></div>
        <div id="p11" class="bar1" style="background-color: #913815; width:6vw"><span>3/span></div>
    </div>`,
  methane_at_300hPa: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
            <div id="p1" class="bar1" style="background-color: #0c0c0c; width: 2.5vw;"><span>0</span></div>
            <div id="p2" class="bar1" style="background-color: #680177; width: 2.5vw;"></div>
            <div id="p3" class="bar1" style="background-color: #850096; width: 2.5vw;"></div>
            <div id="p4" class="bar1" style="background-color: #2d00a4; width: 2.5vw;"><span>1780</span></div>
            <div id="p5" class="bar1" style="background-color: #0000c9; width: 2.5vw;"></div>
            <div id="p6" class="bar1" style="background-color: #0041dd; width: 2.5vw;"></div>
            <div id="p7" class="bar1" style="background-color: #0085dd; width: 2.5vw;"><span>1840</span></div>
            <div id="p8" class="bar1" style="background-color: #009fcb; width: 2.5vw;"></div>
            <div id="p9" class="bar1" style="background-color: #00aaa0; width: 2.5vw;"></div>
            <div id="p10" class="bar1" style="background-color: #00a773; width: 2.5vw;"><span>1900</span></div>
            <div id="p11" class="bar1" style="background-color: #009c00; width: 2.5vw;"></div>
            <div id="p12" class="bar1" style="background-color: #00bd00; width: 2.5vw;"></div>
            <div id="p13" class="bar1" style="background-color: #00da00; width: 2.5vw;"><span>1960</span></div>
            <div id="p14" class="bar1" style="background-color: #00fa00; width: 2.5vw;"></div>
            <div id="p15" class="bar1" style="background-color: #84ff00; width: 2.5vw;"></div>
            <div id="p16" class="bar1" style="background-color: #ceff29; width: 2.5vw;"><span>2020</span></div>
            <div id="p17" class="bar1" style="background-color: #dcf400; width: 2.5vw;"></div>
            <div id="p18" class="bar1" style="background-color: #f8da00; width: 2.5vw;"></div>
            <div id="p19" class="bar1" style="background-color: #ffb500; width: 2.5vw;"><span>2080</span></div>
            <div id="p20" class="bar1" style="background-color: #ff5d00; width: 2.5vw;"></div>
            <div id="p21" class="bar1" style="background-color: #f40000; width: 2.5vw;"></div>
            <div id="p22" class="bar1" style="background-color: #da0000; width: 2.5vw;"><span>2140</span></div>
            <div id="p23" class="bar1" style="background-color: #be0004; width: 2.5vw;"></div>
            <div id="p24" class="bar1" style="background-color: #66001e; width: 2.5vw;"><span>10000</span></div>
    </div>`,
  oceanSal: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #000DB9;width: 4.1vw"><span>0-2</span></div>
        <div id="p2" class="bar1" style="background-color: #0014ED;width: 4.1vw"><span>2-4</span></div>
        <div id="p3" class="bar1" style="background-color: #0028FF;width: 4.1vw"><span>4-7</span></div>
        <div id="p4" class="bar1" style="background-color: #0168FF;width: 4.1vw"><span>7-9</span></div>
        <div id="p5" class="bar1" style="background-color: #00A2FF;width: 4.1vw"><span>9-11</span></div>
        <div id="p6" class="bar1" style="background-color: #00E1FF;width: 4.1vw"><span>11-13</span></div>
        <div id="p7" class="bar1" style="background-color: #13FDEB;width: 4.1vw"><span>13-16</span></div>
        <div id="p8" class="bar1" style="background-color: #46FDB7;width: 4.1vw"><span>16-18</span></div>
        <div id="p9" class="bar1" style="background-color: #77FD86;width: 4.1vw"><span>18-20</span></div>
        <div id="p10" class="bar1" style="background-color:#EEFE10;width: 4.1vw"><span>20-22</span></div>
        <div id="p11" class="bar1" style="background-color:#FEDB02;width: 4.1vw"><span>22-24</span></div>
        <div id="p12" class="bar1" style="background-color:#FEDE00;width: 4.1vw"><span>24-27</span></div>
        <div id="p13" class="bar1" style="background-color:#FEA400;width: 4.1vw"><span>27-29</span></div>
        <div id="p14" class="bar1" style="background-color:#FE4901;width: 4.1vw"><span>29-31</span></div>
        <div id="p15" class="bar1" style="background-color:#FE4201;width: 4.1vw"><span>31-33</span></div>
        <div id="p16" class="bar1" style="background-color:#B00000;width: 4.1vw"><span>33-37</span></div>
        <div id="p20" class="bar1" style="flex: 0;"><span>38psu</span></div>
    </div>`,
  oceanTemp: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="1" class="bar1" style="background-color: #00067F;width: 8vw"><span>200-271</span></div>
        <div id="2" class="bar1" style="background-color: #012EDC;width: 8vw"><span>271-278</span></div>
        <div id="3" class="bar1" style="background-color: #2ADED3;width: 8vw"><span>278-284</span></div>
        <div id="4" class="bar1" style="background-color: #C9FE34;width: 8vw"><span>284-290</span></div>
        <div id="5" class="bar1" style="background-color: #FE9301;width: 8vw"><span>290-296</span></div>
        <div id="5" class="bar1" style="background-color: #D52200;width: 8vw"><span>290-297</span></div>
        <div id="5" class="bar1" style="background-color: #8C0500;width: 8vw"><span>297-303</span></div>
        <div id="5" class="bar1" style="background-color: #7F0000;width: 8vw"><span>303-400</span></div>
    </div>`,
  oceanSurCur: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #99E8FD;width: 5.4vw"><span>0.00-0.10</span></div>
        <div id="p2" class="bar1" style="background-color: #9994FF;width: 5.4vw"><span>0.10-0.20</span></div>
        <div id="p3" class="bar1" style="background-color: #9A40F9;width: 5.4vw"><span>0.20-0.30</span></div>
        <div id="p4" class="bar1" style="background-color: #CC87FE;width: 5.4vw"><span>0.30-0.40</span></div>
        <div id="p5" class="bar1" style="background-color: #A8C0B5;width: 5.4vw"><span>0.40-0.50</span></div>
        <div id="p6" class="bar1" style="background-color: #80FF64;width: 5.4vw"><span>0.50-0.60</span></div>
        <div id="p7" class="bar1" style="background-color: #D1FE2D;width: 5.4vw"><span>0.60-0.70</span></div>
        <div id="p8" class="bar1" style="background-color: #FFD900;width: 5.4vw"><span>0.70-0.80</span></div>
        <div id="p9" class="bar1" style="background-color: #FF8001;width: 5.4vw"><span>0.80-0.90</span></div>
        <div id="p10" class="bar1" style="background-color:#FF3C00;width: 5.4vw"><span>0.90-1.00</span></div>
        <div id="p11" class="bar1" style="background-color:#FF1400;width: 5.4vw"><span>1.00-1.50</span></div>
        <div id="p12" class="bar1" style="background-color:#3C0000;width: 5.4vw"><span>1.50-2.00</span></div>
        <div id="p20" class="bar1" style="flex: 0;"><span>2.50m/s</span></div>
    </div>`,
  oceanSurHeight: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #000892;width: 3.1vw"><span>-2.7</span></div>
        <div id="p2" class="bar1" style="background-color: #000EBD;width: 3.1vw"><span>-2.4</span></div>
        <div id="p3" class="bar1" style="background-color: #0014ED;width: 3.1vw"><span>-2.1</span></div>
        <div id="p4" class="bar1" style="background-color: #0028FF;width: 3.1vw"><span>-1.8</span></div>
        <div id="p5" class="bar1" style="background-color: #0065FF;width: 3.1vw"><span>-1.5</span></div>
        <div id="p6" class="bar1" style="background-color: #0096FF;width: 3.1vw"><span>-1.2</span></div>
        <div id="p7" class="bar1" style="background-color: #00EBFF;width: 3.1vw"><span>-0.9</span></div>
        <div id="p8" class="bar1" style="background-color: #1CFEE0;width: 3.1vw"><span>-0.6</span></div>
        <div id="p9" class="bar1" style="background-color: #5CFDA1;width: 3.1vw"><span>-0.3</span></div>
        <div id="p10" class="bar1" style="background-color: #8DFD70;width: 3.1vw"><span>0.0</span></div>
        <div id="p11" class="bar1" style="background-color: #BBFF42;width: 3.1vw"><span>0.3</span></div>
        <div id="p12" class="bar1" style="background-color: #F6FE0A;width: 3.1vw"><span>0.6</span></div>
        <div id="p13" class="bar1" style="background-color: #FED302;width: 3.1vw"><span>0.9</span></div>
        <div id="p14" class="bar1" style="background-color: #FE9C01;width: 3.1vw"><span>1.2</span></div>
        <div id="p15" class="bar1" style="background-color: #FE7600;width: 3.1vw"><span>1.5</span></div>
        <div id="p16" class="bar1" style="background-color: #FE0800;width: 3.1vw"><span>1.8</span></div>
        <div id="p17" class="bar1" style="background-color: #D80100;width: 3.1vw"><span>2.1</span></div>
        <div id="p18" class="bar1" style="background-color: #D60000;width: 3.1vw"><span>2.4</span></div>
        <div id="p19" class="bar1" style="background-color: #A90000;width: 3.1vw"><span>2.7</span></div>
        <div id="p20" class="bar1" style="background-color: #800000;width: 3.1vw"><span>3.0</span></div>
        <div id="p21" class="bar1" style="background-color: #800000;width: 0vw"><span>3.3</span></div>
    </div>`,
  nemsinLayers: `
    <div style="display: flex;  align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background-color: #C2FBFA;width: 4.6vw"><span>0</span></div>
        <div id="p2" class="bar1" style="background-color: #87A9FD;width: 4.6vw"><span>0.25</span></div>
        <div id="p3" class="bar1" style="background-color: #7B95F9;width: 4.6vw"><span>1</span></div>
        <div id="p4" class="bar1" style="background-color: #3496FE;width: 4.6vw"><span>2</span></div>
        <div id="p5" class="bar1" style="background-color: #3686DD;width: 4.6vw"><span>4</span></div>
        <div id="p6" class="bar1" style="background-color: #35AC9F;width: 4.6vw"><span>6 </span></div>
        <div id="p7" class="bar1" style="background-color: #35D14D;width: 4.6vw"><span>10</span></div>
        <div id="p8" class="bar1" style="background-color: #BEFE35;width: 4.6vw"><span>15</span></div>
        <div id="p9" class="bar1" style="background-color: #5CFDA1;width: 4.6vw"><span>20</span></div>
        <div id="p10" class="bar1" style="background-color: #BE46EB;width: 4.6vw"><span>30</span></div>
        <div id="p11" class="bar1" style="background-color: #FF8134;width: 4.6vw"><span>50</span></div>
        <div id="p12" class="bar1" style="background-color: #FD6334;width: 4.6vw"><span> 70</span></div>
        <div id="p13" class="bar1" style="background-color: #FC4335;width: 4.6vw"><span>100</span></div>
        <div id="p14" class="bar1" style="background-color: #FC4335;width: 0vw"><span>150</span></div>

    </div>`,
  meteobluetemperatureLayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div id="p1" class="bar1" style="background:#348CFE; width:4.6vw"><span>-8</span></div>
        <div id="p2" class="bar1" style="background:#51D4D9; width:4.6vw"><span>-2</span></div>
        <div id="p3" class="bar1" style="background:#00EF7C; width:4.6vw"><span>0</span></div>
        <div id="p4" class="bar1" style="background:#00E452; width:4.6vw"><span>2</span></div>
        <div id="p5" class="bar1" style="background:#00C648; width:4.6vw"><span>4</span></div>
        <div id="p6" class="bar1" style="background:#10B87A; width:4.6vw"><span>6</span></div>
        <div id="p7" class="bar1" style="background:#297B5D; width:4.6vw"><span>8</span></div>
        <div id="p8" class="bar1" style="background:#007229; width:4.6vw"><span>10</span></div>
        <div id="p9" class="bar1" style="background:#3CA12C; width:4.6vw"><span>12</span></div>
        <div id="p12" class="bar1" style="background:#79D130; width:4.6vw"><span>14</span></div>
        <div id="p13" class="bar1" style="background:#B5FF33; width:4.6vw"><span>16</span></div>
        <div id="p14" class="bar1" style="background:#D8F7A1; width:4.6vw"><span>18</span></div>
        <div id="p15" class="bar1" style="background:#FFF600; width:4.6vw"><span>20</span></div>
        <div id="p16" class="bar1" style="background:#F316C2; width:4.6vw"><span>46</span></div>
    </div>`,
  meteoblueRadarLayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div class="bar1" style="background:transparent; width:12.5vw;"><span>Precipitation</span></div>
        <div class="bar1" style="background:#7AE1E8; width:12.5vw;"><span>Drizzle</span></div>
        <div class="bar1" style="background:#02C8D8; width:12.5vw;"><span>Light</span></div>
        <div class="bar1" style="background:#2D7BEA; width:12.5vw;"><span>Moderate</span></div>
        <div class="bar1" style="background:#BE46EB; width:12.5vw;"><span>Heavy</span></div>
    </div>`,
  meteoblueDailySnowfallLayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div class="bar1" style="background:transparent; width:5vw;"><span>SnowFall</span></div>
        <div id="s1" class="bar1" style="background:rgba(230, 250, 255, 0.8); width:3vw"><span>0.1</span></div>
        <div id="s2" class="bar1" style="background:rgba(191, 236, 243, 1.0); width:3vw"><span>0.5</span></div>
        <div id="s3" class="bar1" style="background:rgba(156, 227, 242, 1.0); width:3vw"><span>1</span></div>
        <div id="s4" class="bar1" style="background:rgba(113, 207, 240, 1.0); width:3vw"><span>2</span></div>
        <div id="s5" class="bar1" style="background:rgba(84, 193, 238, 1.0); width:3vw"><span>4</span></div>
        <div id="s6" class="bar1" style="background:rgba(63, 181, 237, 1.0); width:3vw"><span>8</span></div>
        <div id="s7" class="bar1" style="background:rgba(43, 168, 229, 1.0); width:3vw"><span>12</span></div>
        <div id="s8" class="bar1" style="background:rgba(22, 150, 218, 1.0); width:3vw"><span>16</span></div>
        <div id="s9" class="bar1" style="background:rgba(28, 133, 207, 1.0); width:3vw"><span>20</span></div>
        <div id="s10" class="bar1" style="background:rgba(90, 123, 248, 1.0); width:3vw"><span>30</span></div>
        <div id="s11" class="bar1" style="background:rgba(134, 111, 250, 1.0); width:3vw"><span>50</span></div>
        <div id="s12" class="bar1" style="background:rgba(170, 100, 245, 1.0); width:3vw"><span>75</span></div>
        <div id="s13" class="bar1" style="background:rgba(200, 85, 230, 1.0); width:3vw"><span>105</span></div>
        <div id="s14" class="bar1" style="background:rgba(215, 65, 200, 1.0); width:3vw"><span>150</span></div>
        <div id="s15" class="bar1" style="background:rgba(230, 50, 160, 1.0); width:3vw"><span>200</span></div>
        <div id="s16" class="bar1" style="background:rgba(245, 35, 120, 1.0); width:3vw"><span>270</span></div>
        <div id="s17" class="bar1" style="background:rgba(255, 20, 80, 1.0); width:3vw"><span>360</span></div>
    </div>`,
  meteoblueSnowfallHourlyLayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div class="bar1" style="background:transparent; width:5vw;"><span>SnowFall / cm</span></div>
        <div class="bar1" style="background:rgba(230, 250, 255, 0.8); width:3vw;"><span>0.1</span></div>
        <div class="bar1" style="background:rgba(191, 236, 243, 1.0); width:3vw;"><span>0.5</span></div>
        <div class="bar1" style="background:rgba(156, 227, 242, 1.0); width:3vw;"><span>1</span></div>
        <div class="bar1" style="background:rgba(113, 207, 240, 1.0); width:3vw;"><span>2</span></div>
        <div class="bar1" style="background:rgba(84, 193, 238, 1.0); width:3vw;"><span>4</span></div>
        <div class="bar1" style="background:rgba(63, 181, 237, 1.0); width:3vw;"><span>8</span></div>
        <div class="bar1" style="background:rgba(43, 168, 229, 1.0); width:3vw;"><span>12</span></div>
        <div class="bar1" style="background:rgba(22, 150, 218, 1.0); width:3vw;"><span>16</span></div>
        <div class="bar1" style="background:rgba(28, 133, 207, 1.0); width:3vw;"><span>20</span></div>
        <div class="bar1" style="background:rgba(90, 123, 248, 1.0); width:3vw;"><span>25</span></div>
        <div class="bar1" style="background:rgba(134, 111, 250, 1.0); width:3vw;"><span>30</span></div>
        <div class="bar1" style="background:rgba(170, 100, 245, 1.0); width:3vw;"><span>40</span></div>
        <div class="bar1" style="background:rgba(200, 85, 230, 1.0); width:3vw;"><span>50</span></div>
        <div class="bar1" style="background:rgba(215, 65, 200, 1.0); width:3vw;"><span>70</span></div>
        <div class="bar1" style="background:rgba(230, 50, 160, 1.0); width:3vw;"><span>90</span></div>
        <div class="bar1" style="background:rgba(245, 35, 120, 1.0); width:3vw;"><span>110</span></div>
        <div class="bar1" style="background:rgba(255, 20, 80, 1.0); width:3vw;"><span>140</span></div>
    </div>`,
  meteoblueCapeHourlyLayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div class="bar1" style="background:transparent; width:2.6vw;"><span>CAPE (J/kg)</span></div>
        <div class="bar1" style="background:rgba(180, 170, 255, 0.8); width:2.6vw;"><span>25</span></div>
        <div class="bar1" style="background:rgba(130, 120, 255, 1.0); width:2.6vw;"><span>75</span></div>
        <div class="bar1" style="background:rgba(90, 140, 255, 1.0); width:2.6vw;"><span>125</span></div>
        <div class="bar1" style="background:rgba(60, 170, 255, 1.0); width:2.6vw;"><span>250</span></div>
        <div class="bar1" style="background:rgba(0, 200, 255, 1.0); width:2.6vw;"><span>500</span></div>
        <div class="bar1" style="background:rgba(0, 220, 200, 1.0); width:2.6vw;"><span>750</span></div>
        <div class="bar1" style="background:rgba(0, 210, 120, 1.0); width:2.6vw;"><span>1000</span></div>
        <div class="bar1" style="background:rgba(140, 230, 60, 1.0); width:2.6vw;"><span>1250</span></div>
        <div class="bar1" style="background:rgba(230, 230, 40, 1.0); width:2.6vw;"><span>1500</span></div>
        <div class="bar1" style="background:rgba(255, 210, 40, 1.0); width:2.6vw;"><span>1750</span></div>
        <div class="bar1" style="background:rgba(255, 180, 30, 1.0); width:2.6vw;"><span>2000</span></div>
        <div class="bar1" style="background:rgba(255, 150, 20, 1.0); width:2.6vw;"><span>2250</span></div>
        <div class="bar1" style="background:rgba(255, 120, 10, 1.0); width:2.6vw;"><span>2500</span></div>
        <div class="bar1" style="background:rgba(255, 90, 0, 1.0); width:2.6vw;"><span>2750</span></div>
        <div class="bar1" style="background:rgba(255, 60, 0, 1.0); width:2.6vw;"><span>3000</span></div>
        <div class="bar1" style="background:rgba(255, 30, 0, 1.0); width:2.6vw;"><span>3250</span></div>
        <div class="bar1" style="background:rgba(255, 0, 0, 1.0); width:2.6vw;"><span>3500</span></div>
        <div class="bar1" style="background:rgba(240, 0, 0, 1.0); width:2.6vw;"><span>4000</span></div>
        <div class="bar1" style="background:rgba(230, 0, 0, 1.0); width:2.6vw;"><span>4500</span></div>
        <div class="bar1" style="background:rgba(0, 255, 255, 1.0); width:2.6vw;"><span>5000</span></div>
    </div>`,
  meteoblueDailyCAPELayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div class="bar1" style="background:transparent; width:5vw;"><span>CAPE (J/kg)</span></div>
        <div class="bar1" style="background:rgba(180, 170, 255, 0.8); width:2.6vw;"><span>25</span></div>
        <div class="bar1" style="background:rgba(130, 120, 255, 1.0); width:2.6vw;"><span>75</span></div>
        <div class="bar1" style="background:rgba(90, 140, 255, 1.0); width:2.6vw;"><span>125</span></div>
        <div class="bar1" style="background:rgba(60, 170, 255, 1.0); width:2.6vw;"><span>250</span></div>
        <div class="bar1" style="background:rgba(0, 200, 255, 1.0); width:2.6vw;"><span>500</span></div>
        <div class="bar1" style="background:rgba(0, 220, 200, 1.0); width:2.6vw;"><span>750</span></div>
        <div class="bar1" style="background:rgba(0, 210, 120, 1.0); width:2.6vw;"><span>1000</span></div>
        <div class="bar1" style="background:rgba(140, 230, 60, 1.0); width:2.6vw;"><span>1250</span></div>
        <div class="bar1" style="background:rgba(230, 230, 40, 1.0); width:2.6vw;"><span>1500</span></div>
        <div class="bar1" style="background:rgba(255, 210, 40, 1.0); width:2.6vw;"><span>1750</span></div>
        <div class="bar1" style="background:rgba(255, 180, 30, 1.0); width:2.6vw;"><span>2000</span></div>
        <div class="bar1" style="background:rgba(255, 150, 20, 1.0); width:2.6vw;"><span>2250</span></div>
        <div class="bar1" style="background:rgba(255, 120, 10, 1.0); width:2.6vw;"><span>2500</span></div>
        <div class="bar1" style="background:rgba(255, 90, 0, 1.0); width:2.6vw;"><span>2750</span></div>
        <div class="bar1" style="background:rgba(255, 60, 0, 1.0); width:2.6vw;"><span>3000</span></div>
        <div class="bar1" style="background:rgba(255, 30, 0, 1.0); width:2.6vw;"><span>3250</span></div>
        <div class="bar1" style="background:rgba(255, 0, 0, 1.0); width:2.6vw;"><span>3500</span></div>
        <div class="bar1" style="background:rgba(240, 0, 0, 1.0); width:2.6vw;"><span>4000</span></div>
        <div class="bar1" style="background:rgba(230, 0, 0, 1.0); width:2.6vw;"><span>4500</span></div>
        <div class="bar1" style="background:rgba(0, 255, 255, 1.0); width:2.6vw;"><span>5000</span></div>
    </div>`,
  meteoblueForecastWarningsLayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div class="bar1" style="background:transparent; width:8vw;"><span>Risk</span></div>
        <div class="bar1" style="background:rgba(248, 246, 0, 1.0); width:8vw;"><span>Moderate wind</span></div>
        <div class="bar1" style="background:rgba(255, 173, 0, 1.0); width:8vw;"><span>High wind</span></div>
        <div class="bar1" style="background:rgba(255, 26, 0, 1.0); width:8vw;"><span>Severe wind</span></div>
        <div class="bar1" style="background:rgba(145, 201, 255, 1.0); width:8vw;"><span>Moderate precip</span></div>
        <div class="bar1" style="background:rgba(157, 121, 210, 1.0); width:8vw;"><span>High precip</span></div>
        <div class="bar1" style="background:rgba(148, 0, 166, 1.0); width:8vw;"><span>Severe precip</span></div>
    </div>`,
  meteoblueWeatherWarningsLayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div class="bar1" style="background:transparent; width:8vw;"><span>Official warnings</span></div>
        <div class="bar1" style="background:rgba(255, 0, 0, 0.6); width:8vw;"><span>Extreme</span></div>
        <div class="bar1" style="background:rgba(255, 125, 0, 0.6); width:8vw;"><span>Severe</span></div>
        <div class="bar1" style="background:rgba(252, 231, 0, 0.6); width:8vw;"><span>Moderate</span></div>
        <div class="bar1" style="background:rgba(215, 255, 0, 0.6); width:8vw;"><span>Minor</span></div>
        <div class="bar1" style="background:rgba(112, 112, 112, 0.6); width:8vw;"><span>Unknown</span></div>
    </div>`,
  meteoblueStormHelicityHourlyLayers: `
    <div style="display: flex; align-items: center; flex-wrap: wrap;">
        <div class="bar1" style="background:transparent; width:6vw;"><span>Storm helicity</span></div>
        <div class="bar1" style="background:rgba(170, 255, 102, 1.0); width:6vw;"><span>150</span></div>
        <div class="bar1" style="background:rgba(214, 255, 0, 1.0); width:6vw;"><span>200</span></div>
        <div class="bar1" style="background:rgba(255, 230, 0, 1.0); width:6vw;"><span>250</span></div>
        <div class="bar1" style="background:rgba(255, 173, 0, 1.0); width:6vw;"><span>300</span></div>
        <div class="bar1" style="background:rgba(255, 120, 0, 1.0); width:6vw;"><span>400</span></div>
        <div class="bar1" style="background:rgba(255, 96, 160, 1.0); width:6vw;"><span>600</span></div>
        <div class="bar1" style="background:rgba(255, 64, 208, 1.0); width:6vw;"><span>800</span></div>
        <div class="bar1" style="background:rgba(255, 128, 224, 1.0); width:6vw;"><span>1000</span></div>
    </div>`,
};
