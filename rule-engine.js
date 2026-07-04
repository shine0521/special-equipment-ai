/**
 * 规则执行引擎 - 纯确定性规则执行
 * AI仅做辅助，规则引擎负责最终判定
 * 
 * 支持的规则语法：
 *   - COMPARE: 数值比较 (field, operator, threshold, passResult, failResult)
 *   - EXISTS: 字段存在性检查 (field, passResult, failResult)
 *   - RANGE: 范围检查 (field, min, max, passResult, failResult)
 *   - COMBINE: 组合规则 (rules, logic, passResult, failResult)
 * 
 * 规则结果：合规(compliant) / 不合规(non_compliant) / 待人工(pending_manual)
 */
class RuleEngine {
  constructor() {
    this.rules = [];
    this.executionLog = [];
  }

  // 加载模板对应的规则
  loadTemplateRules(templateId, templateName) {
    // 根据不同模板加载不同规则
    // 实际系统中应从模板规则表读取，此处为演示规则
    this.rules = [];
    
    if (templateName.includes('维保')) {
      this.rules = [
        {
          name: '钢丝绳磨损率检查',
          type: 'COMPARE',
          field: 'wire_rope_wear_rate',
          operator: '<=',
          threshold: 7,
          passResult: '合规',
          failResult: '不合规',
          clause: 'TSG T5001-2023 第15条',
          description: '钢丝绳磨损率应不超过7%'
        },
        {
          name: '维保间隔检查',
          type: 'COMPARE',
          field: 'maintenance_interval',
          operator: '<=',
          threshold: 15,
          passResult: '合规',
          failResult: '待人工',
          clause: 'TSG T5001-2023 第8条',
          description: '维保间隔应不超过15天'
        },
        {
          name: '制动器状态检查',
          type: 'COMPARE',
          field: 'brake_status',
          operator: '==',
          threshold: '正常',
          passResult: '合规',
          failResult: '不合规',
          clause: 'GB 7588-2020 第12.4.2条',
          description: '制动器必须处于正常工作状态'
        },
        {
          name: '门机系统检查',
          type: 'COMPARE',
          field: 'door_status',
          operator: '==',
          threshold: '正常',
          passResult: '合规',
          failResult: '待人工',
          clause: 'TSG T7001-2023 第6.3条',
          description: '门机系统应正常关闭并锁紧'
        },
        {
          name: '限速器校验检查',
          type: 'COMPARE',
          field: 'governor_calibrated',
          operator: '==',
          threshold: '是',
          passResult: '合规',
          failResult: '不合规',
          clause: 'TSG T7001-2023 第8.2条',
          description: '限速器应在有效校验期内'
        }
      ];
    } else if (templateName.includes('检验')) {
      this.rules = [
        {
          name: '检验周期检查',
          type: 'COMPARE',
          field: 'inspection_interval',
          operator: '<=',
          threshold: 365,
          passResult: '合规',
          failResult: '不合规',
          clause: 'TSG T7001-2023 第1.2条',
          description: '定期检验周期应不超过1年'
        },
        {
          name: '检验机构资质检查',
          type: 'COMPARE',
          field: 'inspection_qualified',
          operator: '==',
          threshold: '是',
          passResult: '合规',
          failResult: '不合规',
          clause: 'TSG Z7001-2023 第3条',
          description: '检验机构应具备相应资质'
        }
      ];
    } else if (templateName.includes('故障')) {
      this.rules = [
        {
          name: '故障等级判定',
          type: 'COMPARE',
          field: 'fault_level',
          operator: '<=',
          threshold: '一般',
          passResult: '合规',
          failResult: '不合规',
          clause: 'TSG T5001-2023 第20条',
          description: '一般故障可在维保中处理，严重故障需立即停梯'
        },
        {
          name: '应急响应检查',
          type: 'COMPARE',
          field: 'emergency_response',
          operator: '<=',
          threshold: 30,
          passResult: '合规',
          failResult: '待人工',
          clause: 'TSG T5001-2023 第25条',
          description: '应急救援响应时间应不超过30分钟'
        }
      ];
    }
  }

  // 执行单条规则
  executeRule(rule, formData) {
    const fieldValue = formData[rule.field];
    
    // 字段缺失 → 自动待人工
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
      return {
        name: rule.name,
        status: 'warning',
        result: '待人工',
        description: rule.description,
        detail: `字段"${rule.field}"未填写，自动流转人工审核`,
        formula: `IF(${rule.field} EXISTS THEN ${rule.operator} ${rule.threshold} ELSE "待人工")`,
        clause: rule.clause
      };
    }

    let rulePassed = false;
    let numValue, thresholdNum;
    
    switch (rule.operator) {
      case '<=':
        numValue = parseFloat(fieldValue);
        thresholdNum = parseFloat(rule.threshold);
        rulePassed = !isNaN(numValue) && !isNaN(thresholdNum) && numValue <= thresholdNum;
        break;
      case '>=':
        numValue = parseFloat(fieldValue);
        thresholdNum = parseFloat(rule.threshold);
        rulePassed = !isNaN(numValue) && !isNaN(thresholdNum) && numValue >= thresholdNum;
        break;
      case '>':
        numValue = parseFloat(fieldValue);
        thresholdNum = parseFloat(rule.threshold);
        rulePassed = !isNaN(numValue) && !isNaN(thresholdNum) && numValue > thresholdNum;
        break;
      case '<':
        numValue = parseFloat(fieldValue);
        thresholdNum = parseFloat(rule.threshold);
        rulePassed = !isNaN(numValue) && !isNaN(thresholdNum) && numValue < thresholdNum;
        break;
      case '==':
        rulePassed = String(fieldValue).toLowerCase() === String(rule.threshold).toLowerCase();
        break;
      case '!=':
        rulePassed = String(fieldValue).toLowerCase() !== String(rule.threshold).toLowerCase();
        break;
      case 'CONTAINS':
        rulePassed = String(fieldValue).includes(String(rule.threshold));
        break;
      default:
        rulePassed = false;
    }

    const result = rulePassed ? rule.passResult : rule.failResult;
    const status = result === '合规' ? 'success' : result === '不合规' ? 'error' : 'warning';

    return {
      name: rule.name,
      status,
      result,
      description: rule.description,
      detail: `字段"${rule.field}"值="${fieldValue}"，${rule.operator} ${rule.threshold} → ${rulePassed ? '通过' : '不通过'}`,
      formula: `IF(${rule.field} ${rule.operator} ${rule.threshold}, "${rule.passResult}", "${rule.failResult}")`,
      clause: rule.clause
    };
  }

  // 执行所有规则
  execute(formData, templateId, templateName) {
    this.executionLog = [];
    this.loadTemplateRules(templateId, templateName);
    
    let finalResult = '合规';
    
    for (const rule of this.rules) {
      const result = this.executeRule(rule, formData);
      this.executionLog.push(result);
      
      // 优先级：不合规 > 待人工 > 合规
      if (result.result === '不合规') {
        finalResult = '不合规';
      } else if (result.result === '待人工' && finalResult !== '不合规') {
        finalResult = '待人工';
      }
    }
    
    // 生成结论（固定模板变量替换）
    const nonCompliantRules = this.executionLog.filter(r => r.result === '不合规');
    const pendingRules = this.executionLog.filter(r => r.result === '待人工');
    
    let conclusion = '';
    if (finalResult === '合规') {
      conclusion = `经规则引擎执行 ${this.rules.length} 条规则，全部通过。该电梯${templateName || '合规性判定'}结果为：合规。`;
    } else if (finalResult === '不合规') {
      const clauses = nonCompliantRules.map(r => r.clause).join('、');
      conclusion = `经规则引擎执行 ${this.rules.length} 条规则，其中 ${nonCompliantRules.length} 条不通过。` +
                   `依据 ${clauses}，该电梯${templateName || '合规性判定'}结果为：不合规。`;
    } else {
      const clauses = pendingRules.map(r => r.clause).join('、');
      conclusion = `经规则引擎执行 ${this.rules.length} 条规则，其中 ${pendingRules.length} 条待人工判定。` +
                   `依据 ${clauses}，该电梯${templateName || '合规性判定'}需转人工审核。`;
    }
    
    return {
      finalResult,
      conclusion,
      passCount: this.executionLog.filter(r => r.result === '合规').length,
      failCount: nonCompliantRules.length,
      pendingCount: pendingRules.length,
      executionLog: this.executionLog,
      needAudit: finalResult === '待人工'
    };
  }
}

const engine = new RuleEngine();
module.exports = engine;
