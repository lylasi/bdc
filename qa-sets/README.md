# 问答集JSON数据格式说明（简化版）

## 1. 问答集JSON结构

```json
{
  "id": "唯一标识符",
  "name": "问答集名称",
  "category": "分类",
  "description": "描述",
  "creator": "创建者",
  "questions": [
    {
      "qid": "问题编号",
      "question": "问题内容",
      "answer": "答案"
    }
  ]
}
```

## 2. 字段说明

### 顶层字段
- **id**: 字符串，问答集的唯一标识符（如：qa_transport_unit1）
- **name**: 字符串，问答集的显示名称
- **category**: 字符串，分类（如：英语阅读理解、综合知识、数学、科学等）
- **description**: 字符串，简短描述
- **creator**: 字符串，创建者名称（如：系统预置、用户名等）

### questions 问题数组
每个问题对象包含：
- **qid**: 数字，问题编号（从1开始）
- **question**: 字符串，问题内容
- **answer**: 字符串，标准答案

## 3. manifest.json 清单文件

```json
[
  {
    "id": "问答集ID",
    "name": "问答集名称",
    "path": "文件路径",
    "category": "分类"
  }
]
```

## 4. 完整示例

### 示例1：英语阅读理解
```json
{
  "id": "qa_transport_unit1",
  "name": "Unit 1 - Transport and Travel",
  "category": "英语阅读理解",
  "description": "关于交通和旅行的阅读理解问答",
  "creator": "系统预置",
  "questions": [
    {
      "qid": 1,
      "question": "Why was the race difficult for the children?",
      "answer": "It was because they got lost."
    },
    {
      "qid": 2,
      "question": "Why didn't the children take a taxi to the hotel?",
      "answer": "They didn't take a taxi to the hotel because it was against the rules."
    }
  ]
}
```

### 示例2：常识问答
```json
{
  "id": "qa_general_knowledge",
  "name": "常识问答",
  "category": "综合知识",
  "description": "基础常识类问答题",
  "creator": "系统预置",
  "questions": [
    {
      "qid": 1,
      "question": "What is the capital of France?",
      "answer": "The capital of France is Paris."
    },
    {
      "qid": 2,
      "question": "How many days are there in a week?",
      "answer": "There are 7 days in a week."
    }
  ]
}
```

## 5. 使用说明

### 添加新问答集
1. 复制 `qa_custom_template.json` 模板文件
2. 修改id为唯一值（如：qa_math_unit1）
3. 填写name、category、description、creator
4. 在questions数组中添加问题，每个问题需要qid、question、answer
5. 保存文件到 `qa-sets/` 目录
6. 更新 `manifest.json` 添加新问答集信息

### 编辑现有问答集
1. 打开对应的JSON文件
2. 修改questions数组：
   - 添加新问题：增加新的问题对象，qid递增
   - 删除问题：移除对应的问题对象
   - 修改问题：直接编辑question或answer内容
3. 保存文件

## 6. 注意事项

- ID必须唯一，建议使用有意义的命名
- qid从1开始，按顺序递增
- 所有文件使用UTF-8编码
- JSON格式必须严格符合标准，注意逗号和引号
- 答案可以是简短回答或完整句子